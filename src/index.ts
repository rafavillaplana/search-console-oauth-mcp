#!/usr/bin/env node
/**
 * Google Search Console MCP server (stdio) with browser sign-in (OAuth 2.0).
 * Runs locally inside Claude Desktop, Claude Code or any MCP client that launches local servers.
 *
 *   GSC_OAUTH_CLIENT_ID=... GSC_OAUTH_CLIENT_SECRET=... npx -y search-console-oauth-mcp
 *   npx -y search-console-oauth-mcp auth      # sign in from a terminal
 *   npx -y search-console-oauth-mcp logout    # revoke and delete the saved token
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GOOGLE_ENDPOINTS, OAuthManager, readClientFromEnv, type OAuthEndpoints } from "./auth";
import type { ApiBases } from "./gsc";
import { createServer, VERSION } from "./server";

const env = process.env;
const log = (...a: unknown[]) => console.error("[search-console]", ...a); // stdout is reserved for MCP

/** Test-only overrides: point OAuth and the API at local mocks. */
function overrides(): { endpoints?: OAuthEndpoints; bases?: ApiBases } {
  const oauth = env.GSC_OAUTH_BASE;
  const api = env.GSC_API_BASE;
  return {
    endpoints: oauth ? { authUrl: `${oauth}/o/oauth2/v2/auth`, tokenUrl: `${oauth}/token`, revokeUrl: `${oauth}/revoke` } : GOOGLE_ENDPOINTS,
    bases: api ? { webmasters: api, searchconsole: api } : undefined,
  };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "--version" || cmd === "-v") return console.log(VERSION);

  const client = readClientFromEnv(env);
  const { endpoints, bases } = overrides();
  const auth = new OAuthManager({
    client,
    endpoints,
    tokenPath: env.GSC_TOKEN_PATH?.trim() || undefined,
    noBrowser: env.GSC_NO_BROWSER === "1",
  });

  if (cmd === "auth" || cmd === "login") {
    if (!auth.configured) throw new Error("Set GSC_OAUTH_CLIENT_ID and GSC_OAUTH_CLIENT_SECRET (or GSC_OAUTH_CLIENT_FILE) first.");
    const flow = await auth.startSignIn();
    console.log(`Opening Google sign-in in your browser. If nothing opens, visit:\n\n${flow.url}\n`);
    const t = await flow.done;
    console.log(`✔ Signed in${t.email ? ` as ${t.email}` : ""}. Token saved to ${auth.tokenPath}`);
    return;
  }
  if (cmd === "logout") {
    const { revoked } = await auth.signOut();
    console.log(`✔ Signed out${revoked ? " and access revoked at Google" : ""}. Deleted ${auth.tokenPath}`);
    return;
  }

  if (!auth.configured) log("No OAuth client configured; tools will explain how to set it up.");
  const waitMs = Number(env.GSC_AUTH_WAIT_MS);
  const server = createServer({ auth, bases, authWaitMs: Number.isFinite(waitMs) && env.GSC_AUTH_WAIT_MS ? waitMs : undefined });
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready${auth.signedIn ? ` (signed in${auth.email ? ` as ${auth.email}` : ""})` : " (not signed in yet)"}`);
}

main().then(
  () => {
    if (["auth", "login", "logout", "--version", "-v"].includes(process.argv[2] ?? "")) process.exit(0);
  },
  (err) => {
    log("fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
