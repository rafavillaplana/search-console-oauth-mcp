/**
 * Google OAuth 2.0 for installed apps: loopback redirect + PKCE.
 *
 * The user signs in once in their own browser; we keep the refresh token in a local file
 * (readable only by the user) and renew access tokens silently from then on.
 * Docs: https://developers.google.com/identity/protocols/oauth2/native-app
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly", "openid", "email"];

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
};

export interface StoredToken {
  client_id: string;
  refresh_token: string;
  access_token?: string;
  /** Epoch ms when access_token expires. */
  expires_at?: number;
  email?: string;
  scope?: string;
}

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export function defaultTokenPath(): string {
  return path.join(os.homedir(), ".search-console-oauth-mcp", "token.json");
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Reads the email from an id_token. It came straight from Google's token endpoint over TLS, so no signature check is needed to display it. */
export function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** Opens a URL in the user's default browser without a shell (URLs contain & which shells mangle). */
export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1f2328}h1{font-size:1.4rem}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

interface PendingFlow {
  url: string;
  done: Promise<StoredToken>;
  close: () => void;
}

export interface OAuthManagerOptions {
  client?: OAuthClient;
  tokenPath?: string;
  endpoints?: OAuthEndpoints;
  /** Don't launch a browser (tests, headless machines): the URL is still returned. */
  noBrowser?: boolean;
  /** How long a sign-in link stays valid. */
  flowTimeoutMs?: number;
}

export class OAuthManager {
  readonly tokenPath: string;
  private readonly endpoints: OAuthEndpoints;
  private token: StoredToken | undefined;
  private pending: PendingFlow | undefined;
  private refreshing: Promise<string> | undefined;
  private readonly opts: OAuthManagerOptions;

  constructor(opts: OAuthManagerOptions) {
    this.opts = opts;
    this.tokenPath = opts.tokenPath ?? defaultTokenPath();
    this.endpoints = opts.endpoints ?? GOOGLE_ENDPOINTS;
    this.token = this.load();
  }

  get configured(): boolean {
    return !!this.opts.client?.clientId;
  }

  get signedIn(): boolean {
    return !!this.token?.refresh_token;
  }

  get email(): string | undefined {
    return this.token?.email;
  }

  get pendingUrl(): string | undefined {
    return this.pending?.url;
  }

  private client(): OAuthClient {
    if (!this.opts.client?.clientId) {
      throw new Error(
        "No OAuth client configured. Create a Google Cloud OAuth client of type 'Desktop app' and set its Client ID and Client secret in the extension settings (Claude Desktop) or in GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET.",
      );
    }
    return this.opts.client;
  }

  private load(): StoredToken | undefined {
    try {
      const t = JSON.parse(fs.readFileSync(this.tokenPath, "utf8")) as StoredToken;
      // A token issued to another OAuth client can't be refreshed with this one.
      if (!t.refresh_token || (this.opts.client?.clientId && t.client_id !== this.opts.client.clientId)) return undefined;
      return t;
    } catch {
      return undefined;
    }
  }

  private save(t: StoredToken) {
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.tokenPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.tokenPath);
    try {
      fs.chmodSync(this.tokenPath, 0o600);
    } catch {}
    this.token = t;
  }

  private forget() {
    this.token = undefined;
    fs.rmSync(this.tokenPath, { force: true });
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const c = this.client();
    const body = new URLSearchParams({ client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), ...params });
    const res = await fetch(this.endpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Google OAuth error: ${json.error ?? res.status}${json.error_description ? ` (${json.error_description})` : ""}`);
      (err as any).oauthError = json.error;
      throw err;
    }
    return json;
  }

  /** Returns a valid access token, refreshing it if needed. Throws AuthRequiredError if the user must sign in. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    this.client();
    const t = this.token ?? (this.token = this.load());
    if (!t) throw new AuthRequiredError("Not signed in to Google Search Console.");
    if (!forceRefresh && t.access_token && t.expires_at && t.expires_at - 60_000 > Date.now()) return t.access_token;
    // Concurrent tool calls share one refresh.
    this.refreshing ??= (async () => {
      try {
        const r = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
        this.save({ ...t, access_token: r.access_token, expires_at: Date.now() + (r.expires_in ?? 3600) * 1000 });
        return r.access_token as string;
      } catch (e: any) {
        if (e?.oauthError === "invalid_grant") {
          // Revoked, expired (7-day limit of apps in "Testing") or password change: sign in again.
          this.forget();
          throw new AuthRequiredError("The saved Google sign-in has expired or was revoked.");
        }
        throw e;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /**
   * Starts (or reuses) a browser sign-in. Resolves with the sign-in URL immediately;
   * `done` resolves once the user has approved access in the browser.
   */
  async startSignIn(): Promise<PendingFlow> {
    if (this.pending) return this.pending;
    const client = this.client();
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(24));

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const url =
      this.endpoints.authUrl +
      "?" +
      new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        // Always show consent so Google returns a refresh token.
        prompt: "consent select_account",
      }).toString();

    let timer: NodeJS.Timeout | undefined;
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (this.pending?.url === url) this.pending = undefined;
    };

    const done = new Promise<StoredToken>((resolve, reject) => {
      timer = setTimeout(() => {
        close();
        reject(new AuthRequiredError("The sign-in link expired before it was used."));
      }, this.opts.flowTimeoutMs ?? 10 * 60_000);
      timer.unref?.();

      server.on("request", async (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const reply = (status: number, title: string, body: string) =>
          res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, body));

        if (u.searchParams.get("state") !== state) return reply(400, "Invalid request", "This sign-in link does not match. Start again from Claude.");
        const error = u.searchParams.get("error");
        if (error) {
          reply(400, "Access not granted", `Google returned: ${error}. You can close this tab and try again from Claude.`);
          close();
          return reject(new AuthRequiredError(`Sign-in was cancelled or denied (${error}).`));
        }
        try {
          const r = await this.tokenRequest({
            grant_type: "authorization_code",
            code: u.searchParams.get("code") ?? "",
            code_verifier: verifier,
            redirect_uri: redirectUri,
          });
          if (!r.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and sign in again.");
          const granted = String(r.scope ?? "");
          if (granted && !granted.includes("webmasters")) {
            throw new Error("Search Console access was not granted. Sign in again and tick the Search Console permission.");
          }
          const t: StoredToken = {
            client_id: client.clientId,
            refresh_token: r.refresh_token,
            access_token: r.access_token,
            expires_at: Date.now() + (r.expires_in ?? 3600) * 1000,
            email: emailFromIdToken(r.id_token),
            scope: granted || undefined,
          };
          this.save(t);
          reply(
            200,
            "Connected to Search Console ✔",
            `Signed in${t.email ? ` as <b>${t.email.replace(/[<>&"]/g, "")}</b>` : ""}. You can close this tab and go back to Claude.`,
          );
          close();
          resolve(t);
        } catch (e: any) {
          reply(500, "Sign-in failed", String(e?.message ?? e).replace(/[<>&]/g, ""));
          close();
          reject(e);
        }
      });
    });
    done.catch(() => {});

    this.pending = { url, done, close };
    if (!this.opts.noBrowser) openBrowser(url);
    return this.pending;
  }

  /** Waits up to `waitMs` for a started sign-in to finish. Returns the token, or undefined if still waiting. */
  async waitForSignIn(flow: PendingFlow, waitMs: number): Promise<StoredToken | undefined> {
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((r) => {
      t = setTimeout(() => r(undefined), waitMs);
    });
    try {
      return await Promise.race([flow.done, timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  /** Revokes the grant at Google (best effort) and deletes the local token. */
  async signOut(): Promise<{ revoked: boolean }> {
    const t = this.token ?? this.load();
    this.pending?.close();
    let revoked = false;
    if (t?.refresh_token) {
      try {
        const res = await fetch(this.endpoints.revokeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: t.refresh_token }),
        });
        revoked = res.ok;
      } catch {}
    }
    this.forget();
    return { revoked };
  }
}

/** Reads the OAuth client from env vars or from a downloaded client_secret_*.json file. */
export function readClientFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthClient | undefined {
  const clean = (v?: string) => {
    const s = (v ?? "").trim();
    // An unfilled placeholder from a client config is the same as nothing.
    return !s || s.startsWith("${") ? undefined : s;
  };
  const file = clean(env.GSC_OAUTH_CLIENT_FILE);
  if (file) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const c = json.installed ?? json.web ?? json;
    if (!c.client_id) throw new Error(`${file} does not look like a Google OAuth client file (no client_id).`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = clean(env.GSC_OAUTH_CLIENT_ID);
  if (!clientId) return undefined;
  return { clientId, clientSecret: clean(env.GSC_OAUTH_CLIENT_SECRET) };
}
