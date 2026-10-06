# Google Search Console MCP (OAuth)

[![CI](https://github.com/rafavillaplana/search-console-oauth-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rafavillaplana/search-console-oauth-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/search-console-oauth-mcp.svg)](https://www.npmjs.com/package/search-console-oauth-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** · [Español](README.es.md)

A local [MCP](https://modelcontextprotocol.io) server that lets Claude query **Google Search Console** in plain language, **signing in with your Google account in the browser**:

> *"Which Search Console properties do I have?"*
> *"Which queries lost the most clicks this month vs last month on sc-domain:client.com?"*
> *"Is this URL indexed and which canonical did Google pick?"*

**Why not a service account?** With a service account (`xxx@project.iam.gserviceaccount.com`) you have to add that email as a user to every property, one by one. Here Claude acts **as you**: sign in once and it sees **every property your Google account can already access**, including the ones shared with you tomorrow.

- **Runs on your computer.** Talks straight to the official Search Console API. No servers in between.
- **Your own OAuth client.** Created in your own Google Cloud project; you don't depend on anyone else's app.
- **Sign in once.** The refresh token is stored in a local file only your user can read, and access renews silently.
- **Read-only.** `webmasters.readonly` scope: it can't change properties, users or sitemaps.

## 1. Create your OAuth client in Google Cloud (5 minutes, once)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (e.g. *Claude Search Console*).
2. **Enable the API:** *APIs & Services → Library →* search **Google Search Console API** → *Enable*.
3. **Consent screen** (*Google Auth Platform*):
   - *Branding:* app name (e.g. *Claude GSC*) and your support email.
   - *Audience:*
     - **Google Workspace account, only people in your organization →** choose **Internal**. No warnings, no expiry.
     - **Gmail account or outside users →** choose **External**, then click **Publish app** to move it to **In production**.
       ⚠️ If you leave it in *Testing*, Google expires the grant **every 7 days** and you'll have to sign in again.
   - *Data access (optional):* add the `.../auth/webmasters.readonly` scope.
4. **Create the client:** *Clients → Create client →* Application type **Desktop app** → *Create*.
   Copy the **Client ID** (`….apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`).

You don't need Google's app verification to use it yourself (or with your team, up to 100 users). Because it's unverified, the first sign-in shows *"Google hasn't verified this app"*: click **Advanced → Go to Claude GSC**. It's your own app in your own project.

## 2. Install

### Claude Desktop, one click (recommended)

1. Download the latest **`search-console-oauth-mcp-x.y.z.mcpb`** from [Releases](https://github.com/rafavillaplana/search-console-oauth-mcp/releases/latest).
2. Double-click it (or drag it onto Claude Desktop, or *Settings → Extensions → Install extension…*).
3. Paste the **Client ID** and **Client secret** and enable the extension.

Claude Desktop runs extensions with its built-in Node.js, so there's nothing else to install.

### Claude Desktop, manual config

Requires [Node.js](https://nodejs.org) 20+. *Settings → Developer → Edit config*:

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "search-console-oauth-mcp"],
      "env": {
        "GSC_OAUTH_CLIENT_ID": "your-id.apps.googleusercontent.com",
        "GSC_OAUTH_CLIENT_SECRET": "GOCSPX-..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add search-console --scope user \
  -e GSC_OAUTH_CLIENT_ID=your-id.apps.googleusercontent.com \
  -e GSC_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -- npx -y search-console-oauth-mcp
```

Instead of ID and secret you can point to the JSON file Google lets you download: `-e GSC_OAUTH_CLIENT_FILE=/path/client_secret_xxx.json`.

## 3. Sign in

Ask Claude anything (e.g. *"list my Search Console properties"*). The first time, your browser opens Google's sign-in page: pick your account and **tick the Search Console permission**. You'll see *"Connected to Search Console ✔"* and Claude carries on with the answer.

- If no browser opens, Claude gives you the link to open on the same computer.
- From a terminal you can also run `npx search-console-oauth-mcp auth` (same environment variables).
- To **switch Google accounts**, ask Claude to sign out (`sign_out`) and ask again.

## Tools

| Tool | What it does |
|---|---|
| `list_sites` | Every property your account can access, with its permission level |
| `get_site_overview` | Clicks, impressions, CTR and position for a period vs the previous one (or last year) |
| `get_performance` | Full Search Analytics: by query, page, country, device, date and search appearance, with filters (regex included) |
| `get_performance_over_time` | Daily, weekly or monthly series for the whole site or a page/query |
| `compare_periods` | Queries or pages that won or lost the most between two periods (new and lost included) |
| `inspect_url` | URL Inspection: index status, coverage, last crawl, Google vs declared canonical, rich results |
| `list_sitemaps` | Submitted sitemaps, dates, errors and warnings |
| `auth_status` · `sign_in` · `sign_out` | See the connected account, sign in, or disconnect |

By default data covers the **last 28 complete days** (Search Console lags ~2 days). Dates are Pacific Time, as in Search Console itself.

## Security & privacy

- The connector only requests **read** access to Search Console (`webmasters.readonly`) and your email (to show which account is connected).
- The refresh token is stored at `~/.search-console-oauth-mcp/token.json` (Windows: `C:\Users\<you>\.search-console-oauth-mcp\token.json`) with owner-only permissions. Change it with `GSC_TOKEN_PATH`.
- Sign-in uses Google's official installed-app flow: loopback redirect to `127.0.0.1` + PKCE. The link expires after 10 minutes and works once.
- `sign_out` revokes access at Google and deletes the token. You can also revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Don't share your client secret or token file. More in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Message | Fix |
|---|---|
| *Google Search Console API has not been used / is disabled* | Enable the API in the same Google Cloud project as the OAuth client |
| *The saved Google sign-in has expired or was revoked* every week | The app is in *Testing*: publish it (*In production*) or use *Internal* |
| *has no access to this property* | Use the exact `siteUrl` from `list_sites` (`sc-domain:domain.com` or `https://www.domain.com/`) |
| *Search Console permission was not granted* | Sign out and sign in again ticking the Search Console box |
| *invalid_client* in the browser | Wrong ID/secret, or the client isn't a *Desktop app* |

## Development

```bash
npm install
npm run typecheck
npm test          # unit tests
npm run test:e2e  # full flow against a fake Google (OAuth + API)
npm run pack      # builds the .mcpb
```

[MIT](LICENSE) · Made by [Rafa Villaplana](https://rafavillaplana.com). Sibling of [bing-webmaster-tools-mcp](https://github.com/rafavillaplana/bing-webmaster-tools-mcp).

*Not affiliated with Google. Google Search Console is a trademark of Google LLC.*
