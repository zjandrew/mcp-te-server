# @zhoujinandrew/mcp-te-server

MCP proxy server for [ThinkingEngine](https://www.thinkingdata.cn/) with **automatic browser-based authentication**.

Automates the login → token extraction → proxy flow so you never need to manually copy tokens.

## How It Works

```
┌─────────────┐    stdio     ┌──────────────────┐     SSE      ┌──────────────┐
│ Claude Code  │ ←─────────→ │  mcp-te-server   │ ←──────────→ │ TE MCP Server│
│  (client)    │             │  (local proxy)    │  mcpToken    │  (remote)    │
└─────────────┘             └──────────────────┘              └──────────────┘
                                     │
                                     │ Auto-authentication
                                     ▼
                             ┌──────────────────┐
                             │  Default Browser  │
                             │  (AppleScript)    │──→ Login → Extract token
                             └──────────────────┘
```

1. On startup, checks for cached tokens
2. If no valid token, opens your default browser for login
3. Extracts the bearer token from localStorage via AppleScript (macOS)
4. Exchanges it for an `mcpToken` via the ThinkingEngine API
5. Proxies all MCP requests transparently
6. Auto-reconnects and re-authenticates on token expiry or connection errors

## Prerequisites

- **Node.js** >= 18
- **macOS** with Chrome, Brave, Edge, Arc, or Safari
- Access to a ThinkingEngine system instance

## Installation

### Via npx (recommended)

No installation needed — just configure your MCP client directly.

### From source

```bash
git clone https://github.com/zjandrew/mcp-te-server.git
cd mcp-te-server
npm install
npm run build
```

## Configuration

### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "ThinkingEngine": {
      "command": "npx",
      "args": ["-y", "@zhoujinandrew/mcp-te-server"],
      "env": {
        "TE_BASE_URL": "https://your-te-server.example.com",
        "TE_SSE_URL": "https://your-te-server.example.com:18988/mcp/sse"
      }
    }
  }
}
```

### OpenClaw / Other MCP Clients

Same configuration format — use `npx` with `@zhoujinandrew/mcp-te-server`.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TE_BASE_URL` | **Yes** | Base URL of your ThinkingEngine system (e.g., `https://your-te-server.example.com`) |
| `TE_SSE_URL` | No | Override the MCP SSE endpoint URL. Default: `{TE_BASE_URL hostname}:18988/mcp/sse` |

### From source (alternative)

```json
{
  "mcpServers": {
    "ThinkingEngine": {
      "command": "node",
      "args": ["/path/to/mcp-te-server/dist/index.js"],
      "env": {
        "TE_BASE_URL": "https://your-te-server.example.com",
        "TE_SSE_URL": "https://your-te-server.example.com:18988/mcp/sse"
      }
    }
  }
}
```

## Usage

1. Configure your MCP client as shown above
2. Start (or restart) the client
3. On first launch, your default browser opens — log in to ThinkingEngine
4. Token is extracted automatically after login
5. Subsequent launches use cached tokens (no login until expiry)

## Token Management

Tokens are cached at `~/.mcp-te-server/token.json`.

To clear cached tokens:

```bash
rm ~/.mcp-te-server/token.json
```

## Development

```bash
npm install
npm run build      # Build
npm run dev        # Watch mode
npm start          # Run directly
```

## License

MIT
