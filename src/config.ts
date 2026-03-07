import { homedir } from 'os';
import { join } from 'path';

const BASE_URL = process.env.TE_BASE_URL;

if (!BASE_URL) {
  process.stderr.write(
    '[mcp-te-server] ERROR: TE_BASE_URL environment variable is required.\n' +
    '[mcp-te-server] Example: TE_BASE_URL=https://your-te-server.example.com\n',
  );
  process.exit(1);
}

// Strip trailing slash
const baseUrl = BASE_URL.replace(/\/+$/, '');

// Parse host for SSE port URL
const parsedUrl = new URL(baseUrl);
const sseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}:18988/mcp/sse`;

export const CONFIG = {
  // TE System URLs (derived from TE_BASE_URL)
  BASE_URL: baseUrl,
  LOGIN_URL: `${baseUrl}/login`,
  OBTAIN_TOKEN_URL: `${baseUrl}/v1/oauth/obtainMcpToken`,
  SSE_URL: process.env.TE_SSE_URL || sseUrl,

  // localStorage key for bearer token
  BEARER_TOKEN_KEY: 'ACCESS_TOKEN',

  // Local storage paths (isolated per host to avoid token conflicts between different TE instances)
  DATA_DIR: join(homedir(), '.mcp-te-server', parsedUrl.hostname),
  TOKEN_FILE: join(homedir(), '.mcp-te-server', parsedUrl.hostname, 'token.json'),
  CHROME_PROFILE_DIR: join(homedir(), '.mcp-te-server', parsedUrl.hostname, 'chrome-profile'),

  // Timeouts and retries
  LOGIN_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  POLL_INTERVAL_MS: 1000, // 1 second
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000,
} as const;
