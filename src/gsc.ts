/** Thin client for the Google Search Console API, authenticated as the signed-in user. */
import { AuthRequiredError, type OAuthManager } from "./auth";

export interface ApiBases {
  /** Hosts /webmasters/v3 (sites, sitemaps, search analytics). */
  webmasters: string;
  /** Hosts /v1/urlInspection. */
  searchconsole: string;
}

export const GOOGLE_BASES: ApiBases = {
  webmasters: "https://www.googleapis.com",
  searchconsole: "https://searchconsole.googleapis.com",
};

export class GscApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "GscApiError";
  }
}

export class GscClient {
  private readonly auth: OAuthManager;
  private readonly bases: ApiBases;
  constructor(auth: OAuthManager, bases: ApiBases = GOOGLE_BASES) {
    this.auth = auth;
    this.bases = bases;
  }

  private async request<T>(base: keyof ApiBases, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.auth.getAccessToken(retried);
    const res = await fetch(this.bases[base] + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return this.request<T>(base, path, body, true);
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: { message: text.slice(0, 300) } };
    }
    if (!res.ok) {
      const msg: string = json?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new AuthRequiredError("Google rejected the saved sign-in.");
      if (res.status === 403) {
        if (/insufficient|scope/i.test(msg)) {
          throw new GscApiError(`${msg} — Search Console permission was not granted. Use sign_out and sign in again ticking the Search Console box.`, 403);
        }
        if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
          throw new GscApiError(`${msg} — Enable the "Google Search Console API" in the Google Cloud project that owns your OAuth client.`, 403);
        }
        throw new GscApiError(
          `${msg} — The signed-in account${this.auth.email ? ` (${this.auth.email})` : ""} has no access to this property. Check the exact siteUrl with list_sites (e.g. "sc-domain:example.com" or "https://www.example.com/").`,
          403,
        );
      }
      if (res.status === 429) throw new GscApiError(`${msg} — Search Console API quota reached. Wait a minute or narrow the request.`, 429);
      throw new GscApiError(`Search Console API error ${res.status}: ${msg}`, res.status);
    }
    return json as T;
  }

  listSites() {
    return this.request<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>("webmasters", "/webmasters/v3/sites");
  }

  query(siteUrl: string, body: SearchAnalyticsRequest) {
    return this.request<{ rows?: ApiRow[]; responseAggregationType?: string }>(
      "webmasters",
      `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      body,
    );
  }

  listSitemaps(siteUrl: string) {
    return this.request<{ sitemap?: any[] }>("webmasters", `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
  }

  inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string) {
    return this.request<{ inspectionResult?: any }>("searchconsole", "/v1/urlInspection/index:inspect", {
      inspectionUrl,
      siteUrl,
      ...(languageCode ? { languageCode } : {}),
    });
  }
}

export type Dimension = "query" | "page" | "country" | "device" | "date" | "searchAppearance";

export interface Filter {
  dimension: Exclude<Dimension, "date">;
  operator?: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: string;
  dimensionFilterGroups?: { groupType: "and"; filters: Filter[] }[];
  aggregationType?: string;
  rowLimit?: number;
  startRow?: number;
  dataState?: string;
}

export interface ApiRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
