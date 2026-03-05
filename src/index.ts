#!/usr/bin/env node

import { TokenManager } from './token-manager.js';
import { AuthFlow } from './auth-flow.js';
import { McpProxy } from './mcp-proxy.js';

function log(msg: string): void {
  process.stderr.write(`[mcp-te-server] ${msg}\n`);
}

async function main(): Promise<void> {
  log('Starting mcp-te-server...');

  // Initialize token manager
  const tokenManager = new TokenManager();
  await tokenManager.load();

  // Initialize auth flow
  const authFlow = new AuthFlow(tokenManager);

  // Get mcpToken (from cache or through authentication)
  let mcpToken: string;
  try {
    mcpToken = await authFlow.authenticate();
  } catch (error) {
    log(`Authentication failed: ${error}`);
    process.exit(1);
  }

  // Start MCP proxy
  const proxy = new McpProxy(mcpToken);

  // Set up token refresh handler
  proxy.setTokenExpiredHandler(async () => {
    const newToken = await authFlow.reauthenticate();
    proxy.updateToken(newToken);
    return newToken;
  });

  try {
    await proxy.start();
  } catch (error: any) {
    // If connection fails (possibly expired token), try re-authentication
    if (error?.message?.includes('401') || error?.message?.includes('connect')) {
      log('Initial connection failed, attempting re-authentication...');
      try {
        mcpToken = await authFlow.reauthenticate();
        proxy.updateToken(mcpToken);
        await proxy.start();
      } catch (reAuthError) {
        log(`Failed after re-authentication: ${reAuthError}`);
        process.exit(1);
      }
    } else {
      log(`Failed to start proxy: ${error}`);
      process.exit(1);
    }
  }

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    log('Shutting down...');
    await proxy.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('Shutting down...');
    await proxy.close();
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
}

main().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});
