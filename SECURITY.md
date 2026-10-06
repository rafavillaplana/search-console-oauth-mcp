# Security policy

This server holds a Google OAuth refresh token with read access to people's Search Console data, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: *Security → Report a vulnerability* on this repository.

Include what you found, how to reproduce it and its impact. You'll get an acknowledgement within a few days.

## Scope

In scope: the code in this repository and the released `.mcpb` / npm package — the OAuth flow, how tokens are stored and used, the MCP tools, the build and release pipeline.

Out of scope: vulnerabilities in Google Search Console, Google's OAuth service, Claude, or modified copies of this code.

## Design notes

- **Your own OAuth client.** Each user creates a *Desktop app* OAuth client in their own Google Cloud project. Its ID and secret come from `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` (Claude Desktop fills the secret from a `sensitive` extension setting) or from a downloaded `client_secret_*.json` (`GSC_OAUTH_CLIENT_FILE`).
- **Minimal scopes.** `webmasters.readonly`, plus `openid email` only to display the connected account.
- **Installed-app flow.** Loopback redirect to `127.0.0.1` on a random port, PKCE (S256) and a random `state`. The local listener accepts one callback and closes; links expire after 10 minutes.
- **Token storage.** The refresh token is written to `~/.search-console-oauth-mcp/token.json` with mode `0600` inside a `0700` folder (on Windows, your profile folder's ACLs apply). It is never returned by any tool or written to logs. A token issued to a different client ID is ignored.
- **Revocation.** `sign_out` revokes the refresh token at Google and deletes the file. A revoked or expired grant (`invalid_grant`) deletes the local file automatically.
- Tokens are only sent to `oauth2.googleapis.com`, `www.googleapis.com` and `searchconsole.googleapis.com`.
- `GSC_OAUTH_BASE` and `GSC_API_BASE` exist only for the test suite. Never set them in a real configuration: they would send your credentials to another host.
- The released bundle is built by GitHub Actions from the tagged commit; the npm package is published with provenance.
