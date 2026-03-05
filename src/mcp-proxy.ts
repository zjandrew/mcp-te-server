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

    // Register request handlers that proxy to remote
    this.registerHandlers();

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
    } catch (error) {
      log(`Remote does not support tools: ${error}`);
    }

    // Check if remote supports resources
    try {
      const resources = await this.remoteClient.listResources();
      if (resources.resources && resources.resources.length > 0) {
        caps.resources = {};
        log(`Discovered ${resources.resources.length} resources from remote.`);
      }
    } catch (error) {
      log(`Remote does not support resources: ${error}`);
    }

    // Check if remote supports prompts
    try {
      const prompts = await this.remoteClient.listPrompts();
      if (prompts.prompts && prompts.prompts.length > 0) {
        caps.prompts = {};
        log(`Discovered ${prompts.prompts.length} prompts from remote.`);
      }
    } catch (error) {
      log(`Remote does not support prompts: ${error}`);
    }

    return caps;
  }

  private registerHandlers(): void {
    if (!this.localServer || !this.remoteClient) {
      throw new Error('Server or client not initialized');
    }

    const remote = this.remoteClient;

    // Proxy listTools
    this.localServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return await remote.listTools();
    });

    // Proxy callTool
    this.localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await remote.callTool({
          name: request.params.name,
          arguments: request.params.arguments,
        });
      } catch (error: any) {
        // Check if this is a token expiration error
        if (this.isAuthError(error) && this.onTokenExpired) {
          log('Token appears expired, attempting re-authentication...');
          try {
            const newToken = await this.onTokenExpired();
            this.mcpToken = newToken;
            // Reconnect with new token
            await this.reconnectRemote();
            // Retry the call
            return await this.remoteClient!.callTool({
              name: request.params.name,
              arguments: request.params.arguments,
            });
          } catch (reAuthError) {
            log(`Re-authentication failed: ${reAuthError}`);
            throw error; // Throw original error
          }
        }
        throw error;
      }
    });

    // Proxy listResources
    this.localServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      return await remote.listResources();
    });

    // Proxy readResource
    this.localServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await remote.readResource({ uri: request.params.uri });
    });

    // Proxy listPrompts
    this.localServer.setRequestHandler(ListPromptsRequestSchema, async () => {
      return await remote.listPrompts();
    });

    // Proxy getPrompt
    this.localServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await remote.getPrompt({
        name: request.params.name,
        arguments: request.params.arguments,
      });
    });
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
