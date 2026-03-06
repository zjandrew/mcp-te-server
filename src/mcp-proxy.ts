import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CONFIG } from './config.js';

function log(msg: string): void {
  process.stderr.write(`[mcp-te-server] ${msg}\n`);
}

export class McpProxy {
  private remoteClient: Client | null = null;
  private localServer: Server | null = null;
  private mcpToken: string;
  private onTokenExpired: (() => Promise<string>) | null = null;

  constructor(mcpToken: string) {
    this.mcpToken = mcpToken;
  }

  setTokenExpiredHandler(handler: () => Promise<string>): void {
    this.onTokenExpired = handler;
  }

  updateToken(newToken: string): void {
    this.mcpToken = newToken;
  }

  async start(): Promise<void> {
    // Step 1: Connect to remote TE server
    await this.connectToRemote();

    // Step 2: Setup local stdio server that proxies to remote
    await this.setupLocalServer();

    log('MCP proxy started successfully.');
  }

  private async connectToRemote(): Promise<void> {
    log(`Connecting to TE MCP server at ${CONFIG.SSE_URL}...`);

    const url = new URL(CONFIG.SSE_URL);
    const headers = { 'mcpToken': this.mcpToken };
    const transport = new SSEClientTransport(url, {
      // Headers for the initial SSE GET connection
      eventSourceInit: {
        fetch: (url: string | URL, init?: RequestInit) => {
          return fetch(url, {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string> || {}),
              ...headers,
            },
          });
        },
      } as any,
      // Headers for POST requests (sending messages)
      requestInit: {
        headers,
      },
    });

    this.remoteClient = new Client(
      { name: 'mcp-te-proxy-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await this.remoteClient.connect(transport);
    log('Connected to remote TE MCP server.');
  }

  private async setupLocalServer(): Promise<void> {
    // Discover remote capabilities
    const capabilities = await this.discoverCapabilities();

    // Create local server with discovered capabilities
    this.localServer = new Server(
      { name: 'mcp-te-server', version: '1.0.0' },
      { capabilities },
    );

    // Register request handlers that proxy to remote (only for supported capabilities)
    this.registerHandlers(capabilities);

    // Start stdio transport
    const stdioTransport = new StdioServerTransport();
    await this.localServer.connect(stdioTransport);

    log('Local stdio server started.');
  }

  private async discoverCapabilities(): Promise<Record<string, Record<string, never>>> {
    const caps: Record<string, Record<string, never>> = {};

    if (!this.remoteClient) throw new Error('Remote client not connected');

    // Check if remote supports tools
    try {
      const tools = await this.remoteClient.listTools();
      if (tools.tools && tools.tools.length > 0) {
        caps.tools = {};
        log(`Discovered ${tools.tools.length} tools from remote.`);
      }
    } catch {
      log('Remote does not support tools.');
    }

    // Check if remote supports resources
    try {
      const resources = await this.remoteClient.listResources();
      if (resources.resources) {
        caps.resources = {};
        log(`Discovered ${resources.resources.length} resources from remote.`);
      }
    } catch {
      log('Remote does not support resources (skipping).');
    }

    // Check if remote supports prompts
    try {
      const prompts = await this.remoteClient.listPrompts();
      if (prompts.prompts) {
        caps.prompts = {};
        log(`Discovered ${prompts.prompts.length} prompts from remote.`);
      }
    } catch {
      log('Remote does not support prompts (skipping).');
    }

    return caps;
  }

  /**
   * Execute a remote call with automatic reconnection on connection/timeout errors.
   * On auth errors, re-authenticates first. On connection errors, reconnects directly.
   */
  private async withAutoReconnect<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const isLast = attempt >= retries;

        if (this.isAuthError(error) && this.onTokenExpired) {
          log(`Auth error (attempt ${attempt}/${retries}), re-authenticating...`);
          try {
            const newToken = await this.onTokenExpired();
            this.mcpToken = newToken;
            await this.reconnectRemote();
            continue; // retry
          } catch (reAuthError) {
            log(`Re-authentication failed: ${reAuthError}`);
            throw error;
          }
        }

        if (this.isConnectionError(error) && !isLast) {
          log(`Connection error (attempt ${attempt}/${retries}): ${error.message || error}. Reconnecting...`);
          try {
            await this.reconnectRemote();
            continue; // retry
          } catch (reconnectError) {
            log(`Reconnect failed: ${reconnectError}`);
            throw error;
          }
        }

        throw error;
      }
    }

    throw new Error('withAutoReconnect: exhausted retries');
  }

  private registerHandlers(capabilities: Record<string, Record<string, never>>): void {
    if (!this.localServer || !this.remoteClient) {
      throw new Error('Server or client not initialized');
    }

    // Only register handlers for capabilities the remote actually supports

    if (capabilities.tools) {
      this.localServer.setRequestHandler(ListToolsRequestSchema, async () => {
        return await this.withAutoReconnect(() => this.remoteClient!.listTools());
      });

      this.localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        return await this.withAutoReconnect(async () => {
          const result = await this.remoteClient!.callTool({
            name: request.params.name,
            arguments: request.params.arguments,
          });
          // TE server may return auth failure as successful response content
          if (this.isResponseAuthFailure(result)) {
            throw new Error('authentication failed (from response content)');
          }
          return result;
        });
      });
    }

    if (capabilities.resources) {
      this.localServer.setRequestHandler(ListResourcesRequestSchema, async () => {
        return await this.withAutoReconnect(() => this.remoteClient!.listResources());
      });

      this.localServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        return await this.withAutoReconnect(() =>
          this.remoteClient!.readResource({ uri: request.params.uri }),
        );
      });
    }

    if (capabilities.prompts) {
      this.localServer.setRequestHandler(ListPromptsRequestSchema, async () => {
        return await this.withAutoReconnect(() => this.remoteClient!.listPrompts());
      });

      this.localServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
        return await this.withAutoReconnect(() =>
          this.remoteClient!.getPrompt({
            name: request.params.name,
            arguments: request.params.arguments,
          }),
        );
      });
    }
  }

  private isAuthError(error: any): boolean {
    const msg = String(error?.message || error || '').toLowerCase();
    return (
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('token') ||
      msg.includes('auth') ||
      msg.includes('expired')
    );
  }

  private isConnectionError(error: any): boolean {
    const msg = String(error?.message || error || '');
    const code = error?.code;
    return (
      msg.includes('-32001') ||
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('EPIPE') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('SSE') ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ETIMEDOUT'
    );
  }

  /**
   * Check if a successful callTool response actually contains an auth failure message.
   * TE server sometimes returns "authentication failed!" as response content instead of an error.
   */
  private isResponseAuthFailure(result: any): boolean {
    try {
      const content = result?.content;
      if (!Array.isArray(content)) return false;
      for (const item of content) {
        const text = String(item?.text || '').toLowerCase();
        if (text.includes('authentication failed') || text.includes('token expired') || text.includes('invalid token')) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  private async reconnectRemote(): Promise<void> {
    log('Reconnecting to remote with new token...');

    // Close existing connection
    if (this.remoteClient) {
      try {
        await this.remoteClient.close();
      } catch (error) {
        // Ignore close errors
      }
    }

    // Re-establish connection
    await this.connectToRemote();

    // Update the remote reference for handlers
    // (handlers capture `remote` by reference through `this.remoteClient`)
  }

  async close(): Promise<void> {
    if (this.remoteClient) {
      try {
        await this.remoteClient.close();
      } catch (error) {
        // Ignore
      }
    }
    if (this.localServer) {
      try {
        await this.localServer.close();
      } catch (error) {
        // Ignore
      }
    }
  }
}
