import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthRequiredError, type OAuthManager } from "./auth";
import { GOOGLE_BASES, GscClient, type ApiBases, type Dimension, type Filter, type SearchAnalyticsRequest } from "./gsc";
import {
  addDays,
  comparePeriods,
  delta,
  groupSeries,
  normalizeRows,
  previousPeriod,
  resolveRange,
  sortRows,
  totals,
  yearAgo,
  type CompareOrder,
} from "./stats";

export const VERSION = "1.0.0";

export interface ServerOptions {
  auth: OAuthManager;
  /** Overrides API hosts (tests only). */
  bases?: ApiBases;
  /** How long a tool call waits for the user to finish signing in before returning the link. */
  authWaitMs?: number;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const siteUrl = z
  .string()
  .describe('Property exactly as listed by list_sites: "sc-domain:example.com" for domain properties or "https://www.example.com/" for URL-prefix properties.');
const startDate = isoDate.optional().describe("Start date YYYY-MM-DD (Pacific time). Default: 28 days before endDate");
const endDate = isoDate.optional().describe("End date YYYY-MM-DD. Default: 2 days ago (latest complete data)");
const searchType = z
  .enum(["web", "image", "video", "news", "discover", "googleNews"])
  .optional()
  .describe("Search type (default web). discover and googleNews don't support the query dimension");
const dataState = z.enum(["final", "all"]).optional().describe('"all" includes fresh, not-yet-final data from the last ~2 days (default final)');
const dimensionEnum = z.enum(["query", "page", "country", "device", "date", "searchAppearance"]);
const filters = z
  .array(
    z.object({
      dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
      operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]).optional().describe("Default contains"),
      expression: z.string().describe('Value to match. country = ISO-3166 alpha-3 lowercase ("esp"); device = DESKTOP | MOBILE | TABLET; regex uses RE2 syntax'),
    }),
  )
  .optional()
  .describe("Filters, all combined with AND");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const filterGroups = (f?: Filter[]): SearchAnalyticsRequest["dimensionFilterGroups"] =>
  f?.length ? [{ groupType: "and", filters: f.map((x) => ({ ...x, operator: x.operator ?? "contains" })) }] : undefined;

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "Google Search Console", version: VERSION },
    {
      instructions:
        "Google Search Console data for every property the signed-in Google account can access. Call list_sites first to get the exact siteUrl. If the user isn't signed in yet, any tool opens Google's sign-in page in their browser; ask them to approve it and then retry.",
    },
  );
  const auth = opts.auth;
  const gsc = new GscClient(auth, opts.bases ?? GOOGLE_BASES);
  const authWaitMs = opts.authWaitMs ?? 45_000;

  /** Runs `fn`; if the user must sign in, opens the browser, waits briefly and retries once. */
  const withAuth = async (fn: () => Promise<unknown>) => {
    if (!auth.configured) {
      return fail(
        "No OAuth client configured yet. In Google Cloud Console create an OAuth client of type 'Desktop app' (with the Search Console API enabled) and paste its Client ID and Client secret in the extension settings (Claude Desktop → Settings → Extensions) or set GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET.",
      );
    }
    try {
      return ok(await fn());
    } catch (e) {
      if (!(e instanceof AuthRequiredError)) return fail(e instanceof Error ? e.message : String(e));
      let flow;
      try {
        flow = await auth.startSignIn();
      } catch (err) {
        return fail(`Could not start Google sign-in: ${err instanceof Error ? err.message : err}`);
      }
      const t = await auth.waitForSignIn(flow, authWaitMs).catch((err) => err as Error);
      if (t && !(t instanceof Error)) {
        try {
          return ok(await fn());
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }
      return fail(
        `${e.message} A Google sign-in page has been opened in the browser. Ask the user to choose their Google account and allow read access to Search Console, then call this tool again.\n` +
          (t instanceof Error ? `Last attempt: ${t.message}\n` : "") +
          `If no browser window appeared, the user can open this link on this computer:\n${flow.url}`,
      );
    }
  };

  const tool = <S extends z.ZodRawShape>(name: string, title: string, description: string, inputSchema: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    server.registerTool(name, { title, description, inputSchema, annotations: { title, ...READ_ONLY } }, (async (args: any) =>
      withAuth(() => run(args))) as any);
  };

  // ---------------------------------------------------------------- account

  server.registerTool(
    "auth_status",
    {
      title: "Sign-in status",
      description: "Shows whether a Google account is connected, which one, and where the token is stored; while a sign-in is in progress it also returns the link. Does not open the browser.",
      inputSchema: {},
      annotations: { title: "Sign-in status", ...READ_ONLY, openWorldHint: false },
    },
    async () =>
      ok({
        oauthClientConfigured: auth.configured,
        signedIn: auth.signedIn,
        account: auth.email ?? null,
        tokenFile: auth.tokenPath,
        signInInProgress: !!auth.pendingUrl,
        ...(auth.pendingUrl ? { signInUrl: auth.pendingUrl } : {}),
      }),
  );

  server.registerTool(
    "sign_in",
    {
      title: "Sign in with Google",
      description:
        "Opens Google's sign-in page in the user's browser to connect (or switch) the Google account used for Search Console. Other tools also start this automatically when needed.",
      inputSchema: {},
      annotations: { title: "Sign in with Google", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      if (!auth.configured) return withAuth(async () => undefined);
      try {
        const flow = await auth.startSignIn();
        const t = await auth.waitForSignIn(flow, authWaitMs);
        if (t) return ok({ signedIn: true, account: t.email ?? null });
        return ok({
          signedIn: false,
          message: "Sign-in page opened in the browser. Once the user approves access, any Search Console tool will work.",
          url: flow.url,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "sign_out",
    {
      title: "Sign out",
      description: "Disconnects the Google account: revokes this app's access at Google and deletes the locally stored token. Use it to switch accounts.",
      inputSchema: {},
      annotations: { title: "Sign out", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const was = auth.email;
      const { revoked } = await auth.signOut();
      return ok({ signedOut: true, account: was ?? null, revokedAtGoogle: revoked });
    },
  );

  // ---------------------------------------------------------------- data

  tool(
    "list_sites",
    "List properties",
    "Lists every Search Console property the signed-in Google account can access, with its permission level. Call this first to get the exact siteUrl.",
    {
      includeUnverified: z.boolean().optional().describe("Also list properties where the account has no verified access (default false)"),
    },
    async (a) => {
      const sites = (await gsc.listSites()).siteEntry ?? [];
      const list = sites
        .filter((s) => a.includeUnverified || s.permissionLevel !== "siteUnverifiedUser")
        .map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }))
        .sort((x, y) => x.siteUrl.replace(/^(sc-domain:|https?:\/\/)(www\.)?/, "").localeCompare(y.siteUrl.replace(/^(sc-domain:|https?:\/\/)(www\.)?/, "")));
      return { account: auth.email ?? null, count: list.length, sites: list };
    },
  );

  tool(
    "get_site_overview",
    "Site overview",
    "Total clicks, impressions, CTR and average position for a period, compared with the previous period of the same length (or the same dates last year).",
    {
      siteUrl,
      startDate,
      endDate,
      compareTo: z.enum(["previous", "year", "none"]).optional().describe("previous (default): the preceding period of equal length; year: same dates one year earlier"),
      searchType,
      filters,
      dataState,
    },
    async (a) => {
      const range = resolveRange(a.startDate, a.endDate);
      const base = { type: a.searchType, dimensionFilterGroups: filterGroups(a.filters), dataState: a.dataState };
      const cur = totals((await gsc.query(a.siteUrl, { ...range, ...base })).rows);
      if (a.compareTo === "none") return { siteUrl: a.siteUrl, period: range, ...cur };
      const prevRange = a.compareTo === "year" ? yearAgo(range.startDate, range.endDate) : previousPeriod(range.startDate, range.endDate);
      const prev = totals((await gsc.query(a.siteUrl, { ...prevRange, ...base })).rows);
      return { siteUrl: a.siteUrl, period: range, current: cur, comparisonPeriod: prevRange, comparison: prev, change: delta(cur, prev) };
    },
  );

  tool(
    "get_performance",
    "Search performance",
    "Search Analytics query: clicks, impressions, CTR (%) and average position grouped by any combination of query, page, country, device, date and searchAppearance, with filters. Results come sorted by clicks unless sortBy is set. Use it for top queries, top pages, queries of a page, pages of a query, by device/country, etc.",
    {
      siteUrl,
      dimensions: z.array(dimensionEnum).max(4).optional().describe('Group by these dimensions (default ["query"]). Empty array = site totals'),
      startDate,
      endDate,
      filters,
      searchType,
      dataState,
      aggregationType: z.enum(["auto", "byPage", "byProperty"]).optional().describe("How to aggregate (default auto)"),
      sortBy: z.enum(["clicks", "impressions", "ctr", "position"]).optional().describe("Re-sort the returned rows. Note: the API picks the top rows by clicks first"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows (default 100, max 1000). Prefer filters over large limits"),
      startRow: z.number().int().min(0).optional().describe("Skip this many rows (pagination)"),
    },
    async (a) => {
      const range = resolveRange(a.startDate, a.endDate);
      const dimensions = (a.dimensions ?? ["query"]) as Dimension[];
      const limit = a.limit ?? 100;
      const res = await gsc.query(a.siteUrl, {
        ...range,
        dimensions,
        type: a.searchType,
        dimensionFilterGroups: filterGroups(a.filters),
        aggregationType: a.aggregationType,
        dataState: a.dataState,
        rowLimit: limit,
        startRow: a.startRow,
      });
      const rows = sortRows(normalizeRows(res.rows, dimensions) as any[], a.sortBy);
      return {
        siteUrl: a.siteUrl,
        period: range,
        dimensions,
        returned: rows.length,
        ...(rows.length === limit ? { moreAvailable: `Probably more rows: use startRow=${(a.startRow ?? 0) + limit} or narrow with filters.` } : {}),
        rows,
      };
    },
  );

  tool(
    "get_performance_over_time",
    "Performance over time",
    "Time series of clicks, impressions, CTR and position for the whole site or a filtered slice (a page, a query, a country...), by day, week or month.",
    {
      siteUrl,
      startDate: isoDate.optional().describe("Start date YYYY-MM-DD. Default: 90 days before endDate"),
      endDate,
      granularity: z.enum(["day", "week", "month"]).optional().describe("Default day for ≤ 90 days, otherwise week"),
      filters,
      searchType,
      dataState,
    },
    async (a) => {
      const end = resolveRange(a.startDate, a.endDate).endDate;
      const range = resolveRange(a.startDate ?? addDays(end, -89), end);
      const res = await gsc.query(a.siteUrl, {
        ...range,
        dimensions: ["date"],
        type: a.searchType,
        dimensionFilterGroups: filterGroups(a.filters),
        dataState: a.dataState,
        rowLimit: 25000,
      });
      const days = (res.rows ?? []).map((r) => ({ date: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: r.position }));
      const spanDays = (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000 + 1;
      const granularity = a.granularity ?? (spanDays <= 90 ? "day" : "week");
      return { siteUrl: a.siteUrl, period: range, granularity, series: groupSeries(days, granularity) };
    },
  );

  tool(
    "compare_periods",
    "Compare periods",
    "Finds the queries or pages that won or lost the most between two periods (e.g. after an update or a migration): clicks, impressions and position side by side, including new and lost ones.",
    {
      siteUrl,
      dimension: z.enum(["query", "page"]).describe("Compare by query or by page"),
      startDate,
      endDate,
      compareTo: z.enum(["previous", "year"]).optional().describe("previous (default) or same dates last year. Ignored if compareStartDate/compareEndDate are set"),
      compareStartDate: isoDate.optional().describe("Custom comparison period start"),
      compareEndDate: isoDate.optional().describe("Custom comparison period end"),
      orderBy: z
        .enum(["clicks_lost", "clicks_gained", "impressions_lost", "impressions_gained", "position_worse", "position_better"])
        .optional()
        .describe("Which changes to rank (default clicks_lost)"),
      minImpressions: z.number().int().min(0).optional().describe("Ignore rows with fewer impressions in both periods (default 10 for position_*, else 0)"),
      filters,
      searchType,
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)"),
    },
    async (a) => {
      const range = resolveRange(a.startDate, a.endDate);
      const prevRange =
        a.compareStartDate && a.compareEndDate
          ? { startDate: a.compareStartDate, endDate: a.compareEndDate }
          : a.compareTo === "year"
            ? yearAgo(range.startDate, range.endDate)
            : previousPeriod(range.startDate, range.endDate);
      const orderBy = (a.orderBy ?? "clicks_lost") as CompareOrder;
      const base = { dimensions: [a.dimension] as Dimension[], type: a.searchType, dimensionFilterGroups: filterGroups(a.filters), rowLimit: 5000 };
      const [cur, prev] = await Promise.all([gsc.query(a.siteUrl, { ...range, ...base }), gsc.query(a.siteUrl, { ...prevRange, ...base })]);
      const minImp = a.minImpressions ?? (orderBy.startsWith("position") ? 10 : 0);
      const result = comparePeriods(cur.rows, prev.rows, orderBy, a.limit ?? 50, minImp);
      return {
        siteUrl: a.siteUrl,
        dimension: a.dimension,
        period: range,
        comparisonPeriod: prevRange,
        orderBy,
        note: "Each period uses its top 5,000 rows by clicks. positionDelta > 0 means it dropped.",
        ...result,
      };
    },
  );

  tool(
    "inspect_url",
    "Inspect URL",
    "URL Inspection: Google's indexed version of a URL — index verdict, coverage state, last crawl, Google- vs user-declared canonical, robots.txt, sitemaps, rich results. Quota ~2,000 per day per property.",
    {
      siteUrl,
      url: z.string().url().describe("Full URL to inspect; must belong to siteUrl"),
      languageCode: z.string().optional().describe('Language for translated messages, e.g. "es-ES" (default en-US)'),
    },
    async (a) => {
      const r = (await gsc.inspectUrl(a.siteUrl, a.url, a.languageCode)).inspectionResult ?? {};
      return { url: a.url, ...r };
    },
  );

  tool(
    "list_sitemaps",
    "Sitemaps",
    "Sitemaps submitted for a property: last submitted and downloaded dates, pending status, errors, warnings and submitted URL counts.",
    { siteUrl },
    async (a) => {
      const maps = (await gsc.listSitemaps(a.siteUrl)).sitemap ?? [];
      return maps.map((m) => ({
        path: m.path,
        type: m.type,
        isSitemapsIndex: m.isSitemapsIndex,
        lastSubmitted: m.lastSubmitted,
        lastDownloaded: m.lastDownloaded,
        isPending: m.isPending,
        errors: Number(m.errors ?? 0),
        warnings: Number(m.warnings ?? 0),
        contents: (m.contents ?? []).map((c: any) => ({ type: c.type, submitted: Number(c.submitted ?? 0) })),
      }));
    },
  );

  return server;
}
