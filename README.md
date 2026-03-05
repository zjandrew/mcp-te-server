# mcp-te-server

MCP proxy server for [ThinkingEngine](https://www.thinkingdata.cn/) (数数 ThinkingEngine) system with **automatic browser-based authentication**.

一个为数数 ThinkingEngine 系统设计的 MCP 代理服务，支持自动浏览器登录认证。

## Problem / 解决的问题

When using Claude Code with ThinkingEngine's MCP server, you need to manually:
1. Login to the TE web console
2. Copy the `mcpToken`
3. Paste it into Claude Code's MCP configuration
4. Repeat every time the token expires

使用 Claude Code 连接 TE 的 MCP 服务时，你需要手动登录 → 复制 token → 粘贴到配置 → token 过期后重复操作。

**mcp-te-server** automates this entire flow.

## How It Works / 工作原理

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
4. Exchanges it for an `mcpToken` via the TE API
5. Proxies all MCP requests transparently to the remote TE server
6. Automatically refreshes tokens when they expire

## Prerequisites / 前置条件

- **Node.js** >= 18
- **Google Chrome** or **Chromium** installed on your system
- Access to a ThinkingEngine system instance

## Installation / 安装

### Via npx (recommended)

No installation needed — just configure Claude Code directly (see below).

无需安装，直接在 Claude Code 中配置即可（见下方）。

### From source

```bash
git clone https://github.com/your-username/mcp-te-server.git
cd mcp-te-server
npm install
npm run build
```

## Configuration / 配置

### Claude Code

Add the following to your Claude Code MCP configuration (`~/.claude.json`):

在 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "数数 ThinkingEngine": {
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

### Environment Variables / 环境变量

| Variable | Required | Description |
|----------|----------|-------------|
| `TE_BASE_URL` | **Yes** | Base URL of your ThinkingEngine system (e.g., `https://your-te-server.example.com`) |
| `TE_SSE_URL` | No | Override the SSE endpoint URL. Default: `{TE_BASE_URL hostname}:18988/mcp/sse` |

### From source (alternative)

If installed from source, use `node` instead of `npx`:

```json
{
  "mcpServers": {
    "数数 ThinkingEngine": {
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

## Usage / 使用

1. Configure Claude Code as shown above
2. Start (or restart) Claude Code
3. On first launch, a Chrome window will open — log in to your ThinkingEngine system
4. After successful login, the browser closes automatically
5. All subsequent launches use cached tokens (no login required until expiry)

---

1. 按上述方式配置 Claude Code
2. 启动（或重启）Claude Code
3. 首次启动时会打开 Chrome 浏览器窗口 — 登录你的 ThinkingEngine 系统
4. 登录成功后浏览器自动关闭
5. 之后的启动会使用缓存的 token（token 过期前无需再次登录）

## Token Management / Token 管理

Tokens are cached locally at `~/.mcp-te-server/token.json` with `600` file permissions (owner read/write only).

Token 缓存在 `~/.mcp-te-server/token.json`，文件权限为 `600`（仅所有者可读写）。

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

## Platform Support / 平台支持

| Platform | Chrome Detection |
|----------|-----------------|
| **macOS** | Google Chrome, Chromium, Microsoft Edge |
| **Windows** | Chrome (Program Files / LocalAppData), Edge |
| **Linux** | google-chrome, chromium, chromium-browser, snap chromium, edge |

If no system browser is found, falls back to Puppeteer's bundled Chromium.

## Project Structure / 项目结构

```
mcp-te-server/
├── src/
│   ├── index.ts          # Entry point, orchestrates startup
│   ├── config.ts         # Configuration from environment variables
│   ├── token-manager.ts  # Token caching and persistence
│   ├── auth-flow.ts      # Puppeteer login + mcpToken exchange
│   └── mcp-proxy.ts      # stdio ↔ SSE bidirectional proxy
├── docs/
│   └── plans/            # Design documents
├── package.json
└── tsconfig.json
```

## Development / 开发

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

## How the Authentication Flow Works / 认证流程详解

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

## License

MIT
