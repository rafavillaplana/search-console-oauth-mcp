import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { emailFromIdToken, pkcePair, readClientFromEnv } from "../src/auth.ts";
import { comparePeriods, delta, groupSeries, normalizeRows, previousPeriod, resolveRange, sortRows, totals, yearAgo } from "../src/stats.ts";

test("default range: last 28 days ending 2 days ago", () => {
  assert.deepEqual(resolveRange(undefined, undefined, new Date("2026-10-06T10:00:00Z")), { startDate: "2026-09-07", endDate: "2026-10-04" });
  assert.deepEqual(resolveRange("2026-09-01", "2026-09-30"), { startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.throws(() => resolveRange("2026-10-01", "2026-09-01"), /after endDate/);
});

test("previous period and year-over-year", () => {
  assert.deepEqual(previousPeriod("2026-09-01", "2026-09-30"), { startDate: "2026-08-02", endDate: "2026-08-31" });
  assert.deepEqual(yearAgo("2026-09-01", "2026-09-30"), { startDate: "2025-09-01", endDate: "2025-09-30" });
});

test("rows are flattened with CTR in % and rounded position", () => {
  const rows = normalizeRows([{ keys: ["seo valencia", "https://x.com/"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.4444 }], ["query", "page"]);
  assert.deepEqual(rows, [{ query: "seo valencia", page: "https://x.com/", clicks: 3, impressions: 40, ctr: 7.5, position: 4.4 }]);
  assert.deepEqual(totals(undefined), { clicks: 0, impressions: 0, ctr: 0, position: 0 });
});

test("sorting by position puts best (lowest) first", () => {
  const r = sortRows(
    [
      { clicks: 1, impressions: 1, ctr: 1, position: 9 },
      { clicks: 5, impressions: 1, ctr: 1, position: 2 },
    ],
    "position",
  );
  assert.equal(r[0].position, 2);
});

test("delta handles zero baselines", () => {
  const d = delta({ clicks: 10, impressions: 100, ctr: 10, position: 3 }, { clicks: 0, impressions: 50, ctr: 0, position: 5 })!;
  assert.equal(d.clicksPct, null);
  assert.equal(d.impressionsPct, 100);
  assert.equal(d.position, -2);
});

test("weekly series start on Monday and weight position by impressions", () => {
  const s = groupSeries(
    [
      { date: "2026-09-07", clicks: 1, impressions: 10, position: 2 }, // Monday
      { date: "2026-09-13", clicks: 3, impressions: 30, position: 6 }, // Sunday, same week
      { date: "2026-09-14", clicks: 2, impressions: 20, position: 1 },
    ],
    "week",
  );
  assert.deepEqual(s[0], { period: "2026-09-07", clicks: 4, impressions: 40, ctr: 10, position: 5 });
  assert.equal(s[1].period, "2026-09-14");
  assert.equal(groupSeries([{ date: "2026-09-30", clicks: 1, impressions: 2, position: 1 }], "month")[0].period, "2026-09");
});

test("compare periods ranks losers, gainers, new and lost keys", () => {
  const row = (k: string, clicks: number, impressions: number, position: number) => ({ keys: [k], clicks, impressions, ctr: clicks / impressions, position });
  const cur = [row("a", 5, 100, 8), row("b", 50, 500, 2), row("new", 7, 70, 3)];
  const prev = [row("a", 20, 120, 4), row("b", 40, 450, 2.5), row("gone", 9, 90, 5)];

  const lost = comparePeriods(cur, prev, "clicks_lost", 10);
  assert.deepEqual(lost.rows.map((r) => r.key), ["a", "gone"]);
  assert.equal(lost.rows[1].status, "lost");
  assert.equal(lost.matched, 4);

  const gained = comparePeriods(cur, prev, "clicks_gained", 10);
  assert.deepEqual(gained.rows.map((r) => r.key), ["b", "new"]);

  const worse = comparePeriods(cur, prev, "position_worse", 10);
  assert.deepEqual(worse.rows.map((r) => [r.key, r.positionDelta]), [["a", 4]]);
  assert.equal(comparePeriods(cur, prev, "position_worse", 10, 1000).returned, 0);
});

test("PKCE challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
});

test("email is read from the id_token payload", () => {
  const jwt = ["x", Buffer.from(JSON.stringify({ email: "a@b.com" })).toString("base64url"), "sig"].join(".");
  assert.equal(emailFromIdToken(jwt), "a@b.com");
  assert.equal(emailFromIdToken("garbage"), undefined);
});

test("client config from env ignores unfilled placeholders", () => {
  assert.equal(readClientFromEnv({ GSC_OAUTH_CLIENT_ID: "${user_config.client_id}" }), undefined);
  assert.deepEqual(readClientFromEnv({ GSC_OAUTH_CLIENT_ID: " id ", GSC_OAUTH_CLIENT_SECRET: "${x}" }), { clientId: "id", clientSecret: undefined });
});
