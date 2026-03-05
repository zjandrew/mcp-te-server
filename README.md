# mcp-te-server

MCP proxy server for [ThinkingEngine](https://www.thinkingdata.cn/) system with **automatic browser-based authentication**.

## Problem

When using Claude Code with ThinkingEngine's MCP server, you need to manually:
1. Login to the ThinkingEngine web console
2. Copy the `mcpToken`
3. Paste it into Claude Code's MCP configuration
4. Repeat every time the token expires

**mcp-te-server** automates this entire flow.

## How It Works

```
┌─────────────┐    stdio     ┌──────────────────┐     SSE      ┌──────────────┐
│ Claude Code  │ ←─────────→ │  mcp-te-server   │ ←──────────→ │ TE MCP Server│
│  (client)    │             │  (local proxy)    │  mcpToken    │  (remote)    │
└─────────────┘             └──────────────────┘              └──────────────┘
                                     │
                                     │ Authentication
                                     ▼
                             ┌──────────────────┐
                             │   Puppeteer      │
                             │  (browser login) │──→ Login → Extract token
                             └──────────────────┘
```

1. On startup, checks for cached tokens
2. If no valid token, opens a browser window for you to login
3. Extracts the bearer token from localStorage after login
4. Exchanges it for an `mcpToken` via the ThinkingEngine API
5. Proxies all MCP requests transparently to the remote server
6. Automatically refreshes tokens when they expire

## Prerequisites

- **Node.js** >= 18
- **Google Chrome** or **Chromium** installed on your system
- Access to a ThinkingEngine system instance

## Installation

### Via npx (recommended)

No installation needed — just configure Claude Code directly (see below).

### From source

```bash
git clone https://github.com/your-username/mcp-te-server.git
cd mcp-te-server
npm install
npm run build
```

## Configuration

### Claude Code

Add the following to your Claude Code MCP configuration (`~/.claude.json`):

```json
{
  "mcpServers": {
    "ThinkingEngine": {
      "command": "npx",
      "args": ["-y", "mcp-te-server"],
      "env": {
        "TE_BASE_URL": "https://your-te-server.example.com"
      },
      "type": "stdio"
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TE_BASE_URL` | **Yes** | Base URL of your ThinkingEngine system (e.g., `https://your-te-server.example.com`) |
| `TE_SSE_URL` | No | Override the SSE endpoint URL. Default: `{TE_BASE_URL hostname}:18988/mcp/sse` |

### From source (alternative)

If installed from source, use `node` instead of `npx`:

```json
{
  "mcpServers": {
    "ThinkingEngine": {
      "command": "node",
      "args": ["/path/to/mcp-te-server/dist/index.js"],
      "env": {
        "TE_BASE_URL": "https://your-te-server.example.com"
      },
      "type": "stdio"
    }
  }
}
```

## Usage

1. Configure Claude Code as shown above
2. Start (or restart) Claude Code
3. On first launch, a Chrome window will open — log in to your ThinkingEngine system
4. After successful login, the browser closes automatically
5. All subsequent launches use cached tokens (no login required until expiry)

## Authentication Flow

```
┌─────────────────────────────────────────────────┐
│                  Startup                         │
├─────────────────────────────────────────────────┤
│                                                  │
│  1. Load cached tokens from disk                 │
│     ↓                                            │
│  2. Have mcpToken? ──Yes──→ Try to connect       │
│     ↓ No                                         │
│  3. Have bearerToken? ──Yes──→ Call obtainMcp API │
│     ↓ No                           ↓ Success     │
│  4. Open browser for login    Save & connect     │
│     ↓ User logs in                               │
│  5. Extract ACCESS_TOKEN from localStorage       │
│     ↓                                            │
│  6. Call obtainMcpToken API                      │
│     ↓                                            │
│  7. Save tokens & start proxy                    │
│                                                  │
└─────────────────────────────────────────────────┘
```

## Token Management

Tokens are cached locally at `~/.mcp-te-server/token.json` with `600` file permissions (owner read/write only).

**Token refresh strategy:**
- On startup: cached mcpToken → cached bearerToken + API refresh → browser login
- At runtime: automatic re-authentication on 401 errors

To clear cached tokens:

```bash
rm -rf ~/.mcp-te-server/token.json
```

To clear everything (tokens + browser profile):

```bash
rm -rf ~/.mcp-te-server
```

## Platform Support

| Platform | Chrome Detection |
|----------|-----------------|
| **macOS** | Google Chrome, Chromium, Microsoft Edge |
| **Windows** | Chrome (Program Files / LocalAppData), Edge |
| **Linux** | google-chrome, chromium, chromium-browser, snap chromium, edge |

If no system browser is found, falls back to Puppeteer's bundled Chromium.

## Project Structure

```
mcp-te-server/
├── src/
│   ├── index.ts          # Entry point, orchestrates startup
│   ├── config.ts         # Configuration from environment variables
│   ├── token-manager.ts  # Token caching and persistence
│   ├── auth-flow.ts      # Puppeteer login + mcpToken exchange
│   └── mcp-proxy.ts      # stdio ↔ SSE bidirectional proxy
├── package.json
└── tsconfig.json
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Run directly
npm start
```

## License

MIT
