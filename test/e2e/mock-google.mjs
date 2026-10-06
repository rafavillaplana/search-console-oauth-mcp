// Fake Google: OAuth (authorize, token, revoke) + Search Console API, used by the end-to-end test.
// It checks what the real Google checks: client credentials, redirect_uri, PKCE verifier and Bearer tokens.
import crypto from "node:crypto";
import http from "node:http";

export const CLIENT_ID = "test-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "GOCSPX-test";
export const EMAIL = "rafa@example.com";

const idToken = () => ["e30", Buffer.from(JSON.stringify({ email: EMAIL })).toString("base64url"), "sig"].join(".");

export function startMockGoogle(port) {
  const codes = new Map(); // code -> { challenge, redirectUri }
  const access = new Set();
  const refresh = new Set();
  const state = { tokenCalls: 0, refreshCalls: 0, revoked: 0, lastQuery: null, expireNextAccess: false };

  const issue = () => {
    const a = "ya29." + crypto.randomBytes(8).toString("hex");
    if (!state.expireNextAccess) access.add(a);
    state.expireNextAccess = false;
    return a;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const form = (req) =>
    new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = u.pathname;

    // --- OAuth -----------------------------------------------------------
    if (p === "/o/oauth2/v2/auth") {
      const q = u.searchParams;
      const ok =
        q.get("client_id") === CLIENT_ID &&
        q.get("code_challenge_method") === "S256" &&
        q.get("access_type") === "offline" &&
        q.get("scope").includes("webmasters.readonly") &&
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.get("redirect_uri"));
      if (!ok) return json(res, 400, { error: "invalid_request" });
      const deny = q.get("login_hint") === "deny";
      const code = "code-" + crypto.randomBytes(6).toString("hex");
      codes.set(code, { challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("state", q.get("state"));
      if (deny) back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", code);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (p === "/token" && req.method === "POST") {
      state.tokenCalls++;
      const f = new URLSearchParams(await form(req));
      if (f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code"));
        codes.delete(f.get("code"));
        const verifierOk = c && crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
        if (!verifierOk || c.redirectUri !== f.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "Bad code or verifier" });
        const rt = "1//refresh-" + crypto.randomBytes(6).toString("hex");
        refresh.add(rt);
        return json(res, 200, {
          access_token: issue(),
          expires_in: 3599,
          refresh_token: rt,
          scope: "openid https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/userinfo.email",
          id_token: idToken(),
        });
      }
      if (f.get("grant_type") === "refresh_token") {
        state.refreshCalls++;
        if (!refresh.has(f.get("refresh_token"))) return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return json(res, 200, { access_token: issue(), expires_in: 3599 });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (p === "/revoke" && req.method === "POST") {
      const f = new URLSearchParams(await form(req));
      state.revoked++;
      refresh.delete(f.get("token"));
      return json(res, 200, {});
    }

    // --- Search Console API ------------------------------------------------
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!access.has(bearer)) return json(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });

    if (p === "/webmasters/v3/sites") {
      return json(res, 200, {
        siteEntry: [
          { siteUrl: "https://www.example.com/", permissionLevel: "siteFullUser" },
          { siteUrl: "sc-domain:cliente.es", permissionLevel: "siteOwner" },
          { siteUrl: "https://nope.com/", permissionLevel: "siteUnverifiedUser" },
        ],
      });
    }
    const m = p.match(/^\/webmasters\/v3\/sites\/([^/]+)\/(searchAnalytics\/query|sitemaps)$/);
    if (m) {
      const site = decodeURIComponent(m[1]);
      if (site !== "sc-domain:cliente.es") return json(res, 403, { error: { code: 403, message: `User does not have sufficient permission for site '${site}'.` } });
      if (m[2] === "sitemaps") {
        return json(res, 200, { sitemap: [{ path: "https://cliente.es/sitemap.xml", lastSubmitted: "2026-09-01T10:00:00Z", isPending: false, errors: "0", warnings: "2", contents: [{ type: "web", submitted: "120" }] }] });
      }
      const body = JSON.parse(await form(req));
      state.lastQuery = body;
      const dims = body.dimensions ?? [];
      const prev = body.startDate < "2026-09-01";
      if (!dims.length) return json(res, 200, { rows: [prev ? { clicks: 80, impressions: 4000, ctr: 0.02, position: 9 } : { clicks: 100, impressions: 5000, ctr: 0.02, position: 8.04 }] });
      if (dims[0] === "date") {
        return json(res, 200, {
          rows: [
            { keys: ["2026-09-07"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
            { keys: ["2026-09-14"], clicks: 2, impressions: 20, ctr: 0.1, position: 1 },
          ],
        });
      }
      const rows = prev
        ? [
            { keys: ["consultor seo"], clicks: 40, impressions: 900, ctr: 0.044, position: 3 },
            { keys: ["seo valencia"], clicks: 10, impressions: 300, ctr: 0.033, position: 6 },
          ]
        : [
            { keys: ["seo valencia"], clicks: 30, impressions: 600, ctr: 0.05, position: 3.21 },
            { keys: ["consultor seo"], clicks: 12, impressions: 800, ctr: 0.015, position: 7.9 },
          ];
      return json(res, 200, { rows: rows.slice(0, body.rowLimit ?? 1000) });
    }
    if (p === "/v1/urlInspection/index:inspect" && req.method === "POST") {
      const body = JSON.parse(await form(req));
      return json(res, 200, { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: body.inspectionUrl } } });
    }
    json(res, 404, { error: { code: 404, message: "Not found" } });
  });

  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        state,
        expireAllAccessTokens: () => access.clear(),
        revokeAll: () => refresh.clear(),
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}
