# Contributing

Thanks for helping! Issues and pull requests are welcome in English or Spanish.

## Setup

```bash
npm install          # also builds dist/index.js
npm run test:e2e     # full sign-in flow and every tool against a fake Google
```

To try your changes with the real API in Claude Desktop, point a manual config at your local build:

```json
"search-console-dev": {
  "command": "node",
  "args": ["/absolute/path/to/repo/dist/index.js"],
  "env": {
    "GSC_OAUTH_CLIENT_ID": "your-id.apps.googleusercontent.com",
    "GSC_OAUTH_CLIENT_SECRET": "GOCSPX-...",
    "GSC_TOKEN_PATH": "/absolute/path/to/a/dev-token.json"
  }
}
```

or build the extension with `npm run pack` and install the resulting `.mcpb`.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run test:e2e
```

CI runs the same checks on Linux, macOS and Windows.

## Guidelines

- **Read-only.** The connector requests `webmasters.readonly`. Anything needing write scopes (submitting sitemaps, managing users) must be discussed in an issue first.
- **Keep responses small.** Tools return data to a language model; aggregate, filter and cap rows instead of dumping raw API output.
- **Never log or return tokens or the client secret.** Not in errors, not in tool output. Diagnostics go to stderr only: stdout is the MCP channel.
- **Tool descriptions in English.**
