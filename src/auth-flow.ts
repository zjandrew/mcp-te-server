import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { exec } from 'child_process';
import { CONFIG } from './config.js';
import { TokenManager } from './token-manager.js';

function log(msg: string): void {
  process.stderr.write(`[mcp-te-server] ${msg}\n`);
}

export class AuthFlow {
  constructor(private tokenManager: TokenManager) {}

  /**
   * Full authentication flow:
   * 1. Try cached mcpToken
   * 2. Try cached bearerToken → obtainMcpToken
   * 3. Default browser login → obtainMcpToken
   * Returns the mcpToken.
   */
  async authenticate(): Promise<string> {
    // Step 1: Check cached mcpToken
    const cachedMcpToken = this.tokenManager.getMcpToken();
    if (cachedMcpToken) {
      log('Found cached mcpToken, will try to use it...');
      return cachedMcpToken;
    }

    // Step 2: Try cached bearerToken
    const cachedBearerToken = this.tokenManager.getBearerToken();
    if (cachedBearerToken) {
      log('Found cached bearerToken, trying to obtain mcpToken...');
      try {
        const mcpToken = await this.obtainMcpToken(cachedBearerToken);
        await this.tokenManager.setMcpToken(mcpToken);
        log('Successfully obtained mcpToken from cached bearerToken.');
        return mcpToken;
      } catch (error) {
        log(`Cached bearerToken failed: ${error}. Will launch browser login...`);
      }
    }

    // Step 3: Open default browser for login
    log('Starting browser login flow...');
    const bearerToken = await this.browserLogin();
    log('Browser login successful, obtaining mcpToken...');

    const mcpToken = await this.obtainMcpToken(bearerToken);
    await this.tokenManager.setTokens(bearerToken, mcpToken);
    log('Authentication complete. mcpToken obtained and cached.');

    return mcpToken;
  }

  /**
   * Re-authenticate: clear mcpToken and try again.
   * Called when the current mcpToken is rejected by the server.
   */
  async reauthenticate(): Promise<string> {
    log('Re-authenticating...');

    // First try: use bearerToken to get new mcpToken
    const bearerToken = this.tokenManager.getBearerToken();
    if (bearerToken) {
      try {
        const mcpToken = await this.obtainMcpToken(bearerToken);
        await this.tokenManager.setMcpToken(mcpToken);
        log('Re-authentication successful with cached bearerToken.');
        return mcpToken;
      } catch (error) {
        log(`Bearer token refresh failed: ${error}`);
      }
    }

    // Second try: full browser login
    const newBearerToken = await this.browserLogin();
    const mcpToken = await this.obtainMcpToken(newBearerToken);
    await this.tokenManager.setTokens(newBearerToken, mcpToken);
    log('Re-authentication complete via browser login.');

    return mcpToken;
  }

  /**
   * Open TE login page in the system default browser,
   * start a local HTTP server to receive the bearer token.
   *
   * After login, user runs a one-liner in the browser console
   * to send the token back to the local server.
   */
  private async browserLogin(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }

        // Receive token from browser console fetch()
        if (req.method === 'POST' && req.url === '/token') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            const token = this.cleanToken(body);

            if (token && !resolved) {
              resolved = true;
              res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'text/plain; charset=utf-8',
              });
              res.end('Token received! You can close the console.');
              log(`Token received: ${token.substring(0, 8)}...`);
              server.close();
              resolve(token);
            } else {
              res.writeHead(400, {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'text/plain; charset=utf-8',
              });
              res.end('Empty or invalid token. Please try again.');
              log('Received empty token, waiting for retry...');
            }
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;

        // Open login URL in the system default browser
        this.openInDefaultBrowser(CONFIG.LOGIN_URL);

        log('');
        log('════════════════════════════════════════════════════════════');
        log('  TE login page opened in your default browser.');
        log('');
        log('  After logging in, press F12 (or Cmd+Option+J) to open');
        log('  the browser console on the TE page, then paste:');
        log('');
        log(`  fetch('http://127.0.0.1:${port}/token',{method:'POST',body:localStorage.getItem('ACCESS_TOKEN')})`);
        log('');
        log('════════════════════════════════════════════════════════════');
        log('Waiting for token... (timeout: 5 minutes)');
      });

      // Timeout
      const timer = setTimeout(() => {
        if (!resolved) {
          server.close();
          reject(new Error('Login timeout: no token received within 5 minutes.'));
        }
      }, CONFIG.LOGIN_TIMEOUT_MS);

      server.on('close', () => clearTimeout(timer));
    });
  }

  /**
   * Open a URL in the system default browser.
   */
  private openInDefaultBrowser(url: string): void {
    const platform = process.platform;
    let cmd: string;

    if (platform === 'darwin') {
      cmd = `open "${url}"`;
    } else if (platform === 'win32') {
      cmd = `start "" "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (error) => {
      if (error) {
        log(`Could not open browser automatically: ${error.message}`);
        log(`Please open this URL manually: ${url}`);
      }
    });
  }

  /**
   * Clean a token value from localStorage.
   * Values may be JSON-encoded strings (e.g., '"abc"' with embedded quotes).
   */
  private cleanToken(raw: string | null): string | null {
    if (!raw) return null;
    // Strip surrounding quotes if present (JSON-encoded string)
    const cleaned = raw.replace(/^"|"$/g, '');
    return cleaned || null;
  }

  /**
   * Call TE API to exchange bearer token for mcpToken.
   */
  async obtainMcpToken(bearerToken: string): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(CONFIG.OBTAIN_TOKEN_URL, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'authorization': `bearer ${bearerToken}`,
            'content-type': 'application/x-www-form-urlencoded',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: '{}',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json() as {
          return_code: number;
          return_message: string;
          data?: { mcpToken?: string; issueTime?: string };
        };

        if (result.return_code !== 0) {
          throw new Error(`API error (code ${result.return_code}): ${result.return_message}`);
        }

        const mcpToken = result.data?.mcpToken;
        if (!mcpToken) {
          throw new Error(`No mcpToken in response: ${JSON.stringify(result)}`);
        }

        return mcpToken;
      } catch (error) {
        lastError = error as Error;
        log(`obtainMcpToken attempt ${attempt}/${CONFIG.MAX_RETRIES} failed: ${lastError.message}`);

        if (attempt < CONFIG.MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.RETRY_DELAY_MS * attempt),
          );
        }
      }
    }

    throw new Error(`Failed to obtain mcpToken after ${CONFIG.MAX_RETRIES} attempts: ${lastError?.message}`);
  }
}
