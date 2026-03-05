# MCP TE Server 设计文档

**日期**: 2026-03-05
**作者**: Claude + Andrew
**状态**: 已批准

## 概述

开发 `mcp-te-server`，一个 MCP 代理服务，实现数数 ThinkingEngine 系统的自动鉴权和透明代理。

### 目标

- Claude Code 启动时自动检测登录态
- 无登录态时自动打开浏览器完成 OAuth 登录
- 自动获取并缓存 mcpToken
- 透明代理所有 MCP 请求到 TE 远程服务
- 处理 token 过期和自动刷新

## 技术栈

- **语言**: TypeScript + Node.js
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **浏览器自动化**: Puppeteer
- **传输协议**: stdio (Claude ↔ Proxy) + SSE (Proxy ↔ TE)

## 架构设计

### 系统架构图

```
┌─────────────┐     stdio      ┌──────────────────┐      SSE       ┌──────────────┐
│ Claude Code  │ ←───────────→  │  mcp-te-server   │ ←────────────→ │ TE MCP Server│
│  (客户端)    │  stdin/stdout  │  (本地代理)       │   mcpToken     │  (远程)      │
└─────────────┘                └──────────────────┘                └──────────────┘
                                       │
                                       │ 鉴权流程
                                       ▼
                               ┌──────────────────┐
                               │   Puppeteer      │
                               │  (有头浏览器)     │──→ 登录 → 读 localStorage
                               └──────────────────┘
```

### 核心组件

#### 1. TokenManager
负责 token 的缓存、验证和刷新。

**存储位置**: `~/.mcp-te-server/token.json`

**存储结构**:
```json
{
  "bearerToken": "<YOUR-BEARER-TOKEN>",
  "mcpToken": "<YOUR-MCP-TOKEN>",
  "obtainedAt": 1700000000000
}
```

**职责**:
- 读取/写入缓存文件
- 检测 token 是否过期
- 提供 token 刷新接口

#### 2. AuthFlow
处理完整的鉴权流程。

**流程**:
1. 启动 Puppeteer（有头模式）
2. 使用持久化 Chrome Profile (`~/.mcp-te-server/chrome-profile/`)
3. 导航到 `{TE_BASE_URL}/login`
4. 检查 localStorage 中是否已有 `ACCESS_TOKEN`
5. 如果没有，等待用户登录（轮询检测，最长 5 分钟）
6. 提取 `ACCESS_TOKEN` (bearerToken)
7. 调用 `obtainMcpToken` API:
   ```
   POST {TE_BASE_URL}/v1/oauth/obtainMcpToken
   Headers:
     authorization: bearer {bearerToken}
     content-type: application/x-www-form-urlencoded
   Body: {}
   ```
8. 获取 mcpToken 并缓存
9. 关闭浏览器

**持久化 Profile 优势**: 下次启动时如果浏览器 session 仍有效，可直接读取 localStorage，无需重新登录。

#### 3. McpProxy
双向透明代理 MCP 协议。

**实现方式**:
- **Server 端**: 使用 `@modelcontextprotocol/sdk` 的 `Server` + stdio transport
- **Client 端**: 使用 `@modelcontextprotocol/sdk` 的 `Client` + SSE transport

**代理逻辑**:
1. 启动时连接到 TE SSE endpoint，携带 mcpToken header
2. 动态发现 TE server 提供的 tools/resources/prompts
3. 将这些能力注册到本地 stdio server
4. 透传所有请求和响应

**错误处理**:
- SSE 连接失败 (401) → 触发 token 刷新
- 连接断开 → 自动重连（带指数退避）

#### 4. Main (index.ts)
编排启动流程。

**启动逻辑**:
```
1. 读取缓存的 mcpToken
2. 如果有效 → 直接连接 TE SSE
3. 如果无效/过期:
   a. 检查缓存的 bearerToken
   b. 如果有效 → 调用 obtainMcpToken
   c. 如果无效 → 启动 Puppeteer 登录流程
4. 建立 SSE 连接
5. 启动 stdio MCP server
6. 开始代理
```

## 项目结构

```
mcp-te-server/
├── package.json
├── tsconfig.json
├── README.md
├── docs/
│   └── plans/
│       └── 2026-03-05-mcp-te-server-design.md
├── src/
│   ├── index.ts          # 入口，编排启动流程
│   ├── token-manager.ts  # Token 缓存/刷新管理
│   ├── auth-flow.ts      # Puppeteer 登录 + obtainMcpToken
│   ├── mcp-proxy.ts      # stdio ↔ SSE 双向代理
│   └── config.ts         # 配置常量
└── dist/                 # 编译输出
```

## Token 刷新策略

### 启动时
1. 尝试使用缓存的 mcpToken 连接
2. 失败 → 尝试用 bearerToken 刷新 mcpToken
3. 仍失败 → 重新登录

### 运行时
- SSE 连接断开 (401) → 自动刷新 token 并重连
- 其他错误 → 重连（最多 3 次，指数退避）

## Claude Code 配置

替换现有的手动配置：

**之前** (手动 SSE):
```json
"数数 ThinkingEngine": {
  "headers": {
    "mcpToken": "<MANUALLY-COPIED-TOKEN>"
  },
  "type": "sse",
  "url": "https://your-te-server.example.com:18988/mcp/sse"
}
```

**之后** (自动 stdio 代理):
```json
"数数 ThinkingEngine": {
  "command": "npx",
  "args": ["-y", "mcp-te-server"],
  "env": {
    "TE_BASE_URL": "https://your-te-server.example.com"
  },
  "type": "stdio"
}
```

## 安全考虑

1. **Token 存储**: 本地文件权限设为 600 (仅用户可读写)
2. **Chrome Profile**: 隔离存储，避免污染用户主 profile
3. **API 调用**: 使用 HTTPS，验证证书
4. **日志**: 不记录敏感信息（token 值）

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| Puppeteer 启动失败 | 提示用户安装 Chrome/Chromium |
| 登录超时（5分钟） | 退出并提示用户手动登录 |
| obtainMcpToken API 失败 | 重试 3 次，失败后退出 |
| SSE 连接失败 | 指数退避重连，最多 3 次 |
| Token 过期 | 自动刷新，刷新失败则重新登录 |

## 未来优化

- 支持多租户（不同 TE 环境）
- 添加日志级别配置
- 支持 token 过期时间自动检测（而非等连接失败）
- 提供 CLI 命令手动刷新 token
