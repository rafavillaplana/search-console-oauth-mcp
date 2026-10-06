/** Pure helpers: dates, row normalization and period comparisons. No I/O, fully unit-tested. */
import type { ApiRow, Dimension } from "./gsc";

const DAY = 86_400_000;

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDay(new Date(Date.parse(iso + "T00:00:00Z") + n * DAY));
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

/**
 * Fills missing dates. Default: the last 28 complete days, ending 2 days ago
 * (Search Console data lags ~2 days; fresher days are partial).
 */
export function resolveRange(startDate?: string, endDate?: string, now = new Date()): { startDate: string; endDate: string } {
  const end = endDate ?? (startDate ? isoDay(now) : addDays(isoDay(now), -2));
  const start = startDate ?? addDays(end, -27);
  if (start > end) throw new Error(`startDate (${start}) is after endDate (${end}).`);
  return { startDate: start, endDate: end };
}

/** The period of equal length right before the given one. */
export function previousPeriod(startDate: string, endDate: string) {
  const len = daysBetween(startDate, endDate) + 1;
  return { startDate: addDays(startDate, -len), endDate: addDays(startDate, -1) };
}

/** Same dates one year earlier (year-over-year). */
export function yearAgo(startDate: string, endDate: string) {
  const shift = (iso: string) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return isoDay(d);
  };
  return { startDate: shift(startDate), endDate: shift(endDate) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Metrics {
  clicks: number;
  impressions: number;
  /** Percentage, 2 decimals. */
  ctr: number;
  position: number;
}

export const metrics = (r: Pick<ApiRow, "clicks" | "impressions" | "ctr" | "position">): Metrics => ({
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r2(r.ctr * 100),
  position: r1(r.position),
});

/** Turns API rows ({keys:[...]}) into flat objects keyed by dimension name. */
export function normalizeRows(rows: ApiRow[] | undefined, dimensions: Dimension[] = []) {
  return (rows ?? []).map((r) => {
    const o: Record<string, string | number> = {};
    dimensions.forEach((d, i) => (o[d] = r.keys?.[i] ?? ""));
    return Object.assign(o, metrics(r));
  });
}

export type SortKey = "clicks" | "impressions" | "ctr" | "position";

export function sortRows<T extends Metrics>(rows: T[], by?: SortKey): T[] {
  if (!by) return rows;
  // Better position = lower number.
  return [...rows].sort((a, b) => (by === "position" ? a.position - b.position : b[by] - a[by]));
}

export function delta(cur: Metrics, prev: Metrics | undefined) {
  if (!prev) return undefined;
  const pct = (a: number, b: number) => (b === 0 ? null : r1(((a - b) / b) * 100));
  return {
    clicks: cur.clicks - prev.clicks,
    clicksPct: pct(cur.clicks, prev.clicks),
    impressions: cur.impressions - prev.impressions,
    impressionsPct: pct(cur.impressions, prev.impressions),
    ctr: r2(cur.ctr - prev.ctr),
    /** Negative = improved (moved up). */
    position: r1(cur.position - prev.position),
  };
}

const ZERO: ApiRow = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/** Totals of a query without dimensions (API returns one row, or none if there is no data). */
export const totals = (rows: ApiRow[] | undefined): Metrics => metrics(rows?.[0] ?? ZERO);

/** Groups a daily series into weeks (starting Monday) or months, with impression-weighted position. */
export function groupSeries(rows: { date: string; clicks: number; impressions: number; position: number }[], by: "day" | "week" | "month") {
  if (by === "day") return rows.map((r) => ({ period: r.date, ...metricsFrom(r.clicks, r.impressions, r.position * r.impressions) }));
  const acc = new Map<string, { c: number; i: number; p: number }>();
  for (const r of rows) {
    let key = r.date.slice(0, 7);
    if (by === "week") {
      const d = new Date(r.date + "T00:00:00Z");
      key = addDays(r.date, -((d.getUTCDay() + 6) % 7));
    }
    const a = acc.get(key) ?? { c: 0, i: 0, p: 0 };
    a.c += r.clicks;
    a.i += r.impressions;
    a.p += r.position * r.impressions;
    acc.set(key, a);
  }
  return [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([period, a]) => ({ period, ...metricsFrom(a.c, a.i, a.p) }));
}

function metricsFrom(clicks: number, impressions: number, weightedPos: number): Metrics {
  return {
    clicks,
    impressions,
    ctr: impressions ? r2((clicks / impressions) * 100) : 0,
    position: impressions ? r1(weightedPos / impressions) : 0,
  };
}

export type CompareOrder = "clicks_lost" | "clicks_gained" | "impressions_lost" | "impressions_gained" | "position_worse" | "position_better";

/** Joins two periods by key (query or page) and ranks the biggest changes. */
export function comparePeriods(current: ApiRow[] | undefined, previous: ApiRow[] | undefined, orderBy: CompareOrder, limit: number, minImpressions = 0) {
  const prev = new Map((previous ?? []).map((r) => [r.keys?.[0] ?? "", r]));
  const seen = new Set<string>();
  const rows = (current ?? []).map((r) => {
    const key = r.keys?.[0] ?? "";
    seen.add(key);
    const p = prev.get(key);
    return { key, current: metrics(r), previous: p ? metrics(p) : null };
  });
  for (const [key, p] of prev) if (!seen.has(key)) rows.push({ key, current: metrics(ZERO), previous: metrics(p) });

  const withDelta = rows.map((r) => {
    const prevM = r.previous ?? metrics(ZERO);
    const status = !r.previous ? "new" : r.current.impressions === 0 ? "lost" : "both";
    return {
      key: r.key,
      status,
      clicks: r.current.clicks,
      clicksPrev: prevM.clicks,
      clicksDelta: r.current.clicks - prevM.clicks,
      impressions: r.current.impressions,
      impressionsPrev: prevM.impressions,
      impressionsDelta: r.current.impressions - prevM.impressions,
      position: status === "lost" ? null : r.current.position,
      positionPrev: status === "new" ? null : prevM.position,
      positionDelta: status === "both" ? r1(r.current.position - prevM.position) : null,
    };
  });

  const score: Record<CompareOrder, (r: (typeof withDelta)[number]) => number | null> = {
    clicks_lost: (r) => r.clicksDelta,
    clicks_gained: (r) => -r.clicksDelta,
    impressions_lost: (r) => r.impressionsDelta,
    impressions_gained: (r) => -r.impressionsDelta,
    // Only rows ranking in both periods have a meaningful position change.
    position_worse: (r) => (r.positionDelta === null ? null : -r.positionDelta),
    position_better: (r) => r.positionDelta,
  };
  const s = score[orderBy];
  const ranked = withDelta
    .filter((r) => s(r) !== null && (s(r) as number) < 0 && Math.max(r.impressions, r.impressionsPrev) >= minImpressions)
    .sort((a, b) => (s(a) as number) - (s(b) as number) || b.impressions + b.impressionsPrev - (a.impressions + a.impressionsPrev));
  return { matched: withDelta.length, returned: Math.min(limit, ranked.length), rows: ranked.slice(0, limit) };
}
