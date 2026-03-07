# npm publish design: @thinkingdata/mcp-te-server

## Goal

Publish mcp-te-server to npm as `@thinkingdata/mcp-te-server`, enabling users to run via `npx` and configure in Claude Code, OpenClaw, etc.

## Changes

### package.json
- Rename to `@thinkingdata/mcp-te-server`
- Remove `puppeteer` dependency (replaced by AppleScript)
- Add `"files": ["dist"]` to only publish compiled output
- Add `"prepublishOnly": "npm run build"` to auto-build before publish

### config.ts
- Already supports `TE_BASE_URL` (required) and `TE_SSE_URL` (optional)
- No changes needed

### README.md
- Add installation and usage instructions
- Add Claude Code / OpenClaw configuration examples
- Document environment variables

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TE_BASE_URL` | Yes | TE system address, e.g. `https://your-te-instance.com` |
| `TE_SSE_URL` | No | MCP SSE endpoint, defaults to `{hostname}:18988/mcp/sse` |

## User Configuration Example

```json
{
  "mcpServers": {
    "TE审计系统": {
      "command": "npx",
      "args": ["-y", "@thinkingdata/mcp-te-server"],
      "env": {
        "TE_BASE_URL": "https://your-te-instance.com",
        "TE_SSE_URL": "https://your-te-instance.com:18988/mcp/sse"
      }
    }
  }
}
```

## Publish Steps

1. Create `@thinkingdata` org on npmjs.com (free, public)
2. `npm login`
3. `npm publish --access public`
