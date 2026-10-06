// End-to-end test: launches the built server (dist/index.js) over stdio, exactly like
// Claude Desktop or Claude Code do, against a fake Google (OAuth + Search Console API).
// It walks the real browser sign-in flow: authorize → loopback callback → PKCE code exchange.
// Run with: npm run test:e2e
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLIENT_ID, CLIENT_SECRET, EMAIL, startMockGoogle } from "./mock-google.mjs";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gsc-e2e-")), "nested", "token.json");
const TOOL_COUNT = 10;
const step = (msg) => console.log(`✔ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(env) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        PATH: process.env.PATH ?? "",
        GSC_OAUTH_BASE: BASE,
        GSC_API_BASE: BASE,
        GSC_NO_BROWSER: "1",
        GSC_AUTH_WAIT_MS: "4000",
        GSC_TOKEN_PATH: TOKEN,
        ...env,
      },
      stderr: "ignore",
    }),
  );
  return client;
}
const configured = () => connect({ GSC_OAUTH_CLIENT_ID: CLIENT_ID, GSC_OAUTH_CLIENT_SECRET: CLIENT_SECRET });

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
}

/** Plays the user's browser: opens the sign-in link and follows Google's redirect back to the local callback. */
async function browser(url) {
  try {
    const res = await fetch(url);
    return { status: res.status, html: await res.text() };
  } catch {
    return { status: 0, html: "" }; // nothing listening any more
  }
}
const linkIn = (text) => text.match(/https?:\/\/\S+\/o\/oauth2\/v2\/auth\?\S+/)?.[0];

const mock = await startMockGoogle(PORT);
let client;
try {
  // 1. No OAuth client configured -----------------------------------------
  client = await connect({ GSC_OAUTH_CLIENT_ID: "${user_config.client_id}" });
  assert.equal(client.getServerVersion().name, "Google Search Console");
  const { tools } = await client.listTools();
  assert.equal(tools.length, TOOL_COUNT);
  const data = tools.filter((t) => !["sign_in", "sign_out"].includes(t.name));
  assert.ok(data.every((t) => t.annotations?.readOnlyHint === true));
  const missing = await call(client, "list_sites");
  assert.ok(missing.isError);
  assert.match(missing.text, /No OAuth client configured/);
  await client.close();
  step(`server starts without credentials, lists ${TOOL_COUNT} tools and explains the setup`);

  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.user_config.client_secret.sensitive, true);
  assert.equal(manifest.server.mcp_config.env.GSC_OAUTH_CLIENT_ID, "${user_config.client_id}");
  assert.equal(manifest.server.mcp_config.env.GSC_OAUTH_CLIENT_SECRET, "${user_config.client_secret}");
  step("extension manifest passes the client secret as a sensitive setting");

  // 2. First use: sign-in link, then the browser flow ----------------------
  client = await configured();
  const first = await call(client, "list_sites");
  assert.ok(first.isError);
  const url = linkIn(first.text);
  assert.ok(url, "the error includes a sign-in link");
  assert.match(url, /code_challenge_method=S256/);
  assert.match(url, /access_type=offline/);
  step("first call without a token returns Google's sign-in link (PKCE + offline access)");

  // The user approves while Claude retries: the pending call waits and then succeeds.
  const retry = call(client, "list_sites");
  await sleep(300);
  const page = await browser(url);
  assert.equal(page.status, 200);
  assert.match(page.html, /Connected to Search Console/);
  const sites = await retry;
  assert.ok(!sites.isError, sites.text);
  assert.equal(sites.data.account, EMAIL);
  assert.deepEqual(
    sites.data.sites.map((s) => s.siteUrl),
    ["sc-domain:cliente.es", "https://www.example.com/"],
  );
  step("browser approval completes the flow and the waiting call returns every property (unverified ones hidden)");

  const saved = JSON.parse(fs.readFileSync(TOKEN, "utf8"));
  assert.ok(saved.refresh_token.startsWith("1//"));
  assert.equal(saved.email, EMAIL);
  if (process.platform !== "win32") assert.equal(fs.statSync(TOKEN).mode & 0o777, 0o600);
  const status = await call(client, "auth_status");
  assert.equal(status.data.signedIn, true);
  assert.equal(status.data.account, EMAIL);
  step("refresh token saved locally with owner-only permissions");

  // Once used, the local callback is closed: the link can't be replayed.
  const replay = await browser(url);
  assert.notEqual(replay.status, 200);
  step("the sign-in link cannot be replayed");

  // 3. Data tools ------------------------------------------------------------
  const site = "sc-domain:cliente.es";
  const ov = await call(client, "get_site_overview", { siteUrl: site, startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.deepEqual(ov.data.current, { clicks: 100, impressions: 5000, ctr: 2, position: 8 });
  assert.deepEqual(ov.data.comparisonPeriod, { startDate: "2026-08-02", endDate: "2026-08-31" });
  assert.equal(ov.data.change.clicksPct, 25);

  const perf = await call(client, "get_performance", {
    siteUrl: site,
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    dimensions: ["query"],
    filters: [{ dimension: "country", expression: "esp", operator: "equals" }],
    limit: 2,
  });
  assert.deepEqual(perf.data.rows[0], { query: "seo valencia", clicks: 30, impressions: 600, ctr: 5, position: 3.2 });
  assert.ok(perf.data.moreAvailable);
  assert.deepEqual(mock.state.lastQuery.dimensionFilterGroups, [{ groupType: "and", filters: [{ dimension: "country", expression: "esp", operator: "equals" }] }]);

  const series = await call(client, "get_performance_over_time", { siteUrl: site, startDate: "2026-09-01", endDate: "2026-09-30", granularity: "week" });
  assert.equal(series.data.series.length, 2);

  const cmp = await call(client, "compare_periods", { siteUrl: site, dimension: "query", startDate: "2026-09-01", endDate: "2026-09-30" });
  assert.equal(cmp.data.rows[0].key, "consultor seo");
  assert.equal(cmp.data.rows[0].clicksDelta, -28);

  const insp = await call(client, "inspect_url", { siteUrl: site, url: "https://cliente.es/servicios/" });
  assert.equal(insp.data.indexStatusResult.verdict, "PASS");

  const maps = await call(client, "list_sitemaps", { siteUrl: site });
  assert.deepEqual(maps.data[0].contents, [{ type: "web", submitted: 120 }]);
  step("overview, performance (filters), time series, period comparison, URL inspection and sitemaps work");

  const denied = await call(client, "get_performance", { siteUrl: "https://www.example.com/" });
  assert.ok(denied.isError);
  assert.match(denied.text, /has no access to this property/);
  step("a property the account can't read gives a clear 403 explanation");

  // 4. Token lifecycle -------------------------------------------------------
  const before = mock.state.refreshCalls;
  mock.expireAllAccessTokens();
  const afterExpiry = await call(client, "list_sites");
  assert.ok(!afterExpiry.isError, afterExpiry.text);
  assert.equal(mock.state.refreshCalls, before + 1);
  step("an expired access token is refreshed silently");
  await client.close();

  client = await configured();
  const persisted = await call(client, "list_sites");
  assert.ok(!persisted.isError);
  step("the sign-in survives a restart of Claude (no new login)");

  mock.revokeAll();
  mock.expireAllAccessTokens();
  const revoked = await call(client, "list_sites");
  assert.ok(revoked.isError);
  assert.match(revoked.text, /expired or was revoked/);
  assert.ok(linkIn(revoked.text));
  assert.ok(!fs.existsSync(TOKEN));
  step("a revoked/expired grant deletes the token and offers a new sign-in link");

  // Sign in again via the sign_in tool, then sign out.
  const signIn = call(client, "sign_in");
  await sleep(300);
  const pending = await call(client, "auth_status");
  assert.equal(pending.data.signInInProgress, true);
  await browser(pending.data.signInUrl);
  const signedIn = await signIn;
  assert.equal(signedIn.data.signedIn, true);
  const out = await call(client, "sign_out");
  assert.equal(out.data.revokedAtGoogle, true);
  assert.ok(!fs.existsSync(TOKEN));
  assert.equal((await call(client, "auth_status")).data.signedIn, false);
  step("sign_in and sign_out (revokes at Google and deletes the token)");
  await client.close();

  // 5. Wrong client secret ---------------------------------------------------
  client = await connect({ GSC_OAUTH_CLIENT_ID: CLIENT_ID, GSC_OAUTH_CLIENT_SECRET: "wrong" });
  const bad = await call(client, "list_sites");
  const badPage = await browser(linkIn(bad.text));
  assert.equal(badPage.status, 500);
  assert.match(badPage.html, /invalid_client/);
  step("a wrong client secret shows a clear error in the browser");

  console.log("\nAll end-to-end checks passed.");
} catch (e) {
  console.error("\n✘ " + (e.stack ?? e));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  mock.close();
}

