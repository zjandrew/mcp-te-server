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
   * Flow:
   * 1. Open TE login page in default browser
   * 2. Open a local guide page with clear instructions
   * 3. User logs in, then sends token via console command or paste
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

        // Serve the guide page
        if (req.method === 'GET' && (req.url === '/' || req.url === '/guide')) {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.buildGuidePage(port));
          return;
        }

        // Token receipt status (polled by guide page)
        if (req.method === 'GET' && req.url === '/status') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ received: resolved }));
          return;
        }

        // Receive token from browser console fetch() or guide page form
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
              res.end('OK');
              log(`Token received: ${token.substring(0, 8)}...`);
              server.close();
              resolve(token);
            } else {
              res.writeHead(400, {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'text/plain; charset=utf-8',
              });
              res.end('Empty or invalid token.');
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

        // Open TE login page first
        this.openInDefaultBrowser(CONFIG.LOGIN_URL);

        // Open the local guide page after a short delay
        setTimeout(() => {
          this.openInDefaultBrowser(`http://127.0.0.1:${port}/guide`);
        }, 1500);

        log(`Guide page: http://127.0.0.1:${port}/guide`);
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
   * Build the HTML guide page for token extraction.
   */
  private buildGuidePage(port: number): string {
    const fetchCmd = `fetch('http://127.0.0.1:${port}/token',{method:'POST',body:localStorage.getItem('ACCESS_TOKEN')})`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TE System - Token Transfer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  .container { max-width: 640px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 28px; text-align: center; margin-bottom: 8px; }
  .subtitle { text-align: center; color: #86868b; margin-bottom: 32px; font-size: 15px; }
  .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .step-num { display: inline-block; width: 28px; height: 28px; background: #007AFF; color: white; border-radius: 50%; text-align: center; line-height: 28px; font-weight: 600; font-size: 14px; margin-right: 10px; }
  .step-title { font-size: 17px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; }
  .command-box { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 8px; font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 13px; word-break: break-all; line-height: 1.5; margin: 12px 0; position: relative; }
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; border: none; font-size: 15px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: #007AFF; color: white; }
  .btn-primary:hover { background: #0056CC; }
  .btn-success { background: #34C759; color: white; }
  .divider { text-align: center; color: #86868b; margin: 16px 0; font-size: 14px; }
  textarea { width: 100%; height: 56px; border: 2px solid #d2d2d7; border-radius: 8px; padding: 10px; font-family: monospace; font-size: 14px; resize: vertical; }
  textarea:focus { outline: none; border-color: #007AFF; }
  .status { text-align: center; padding: 16px; border-radius: 12px; font-size: 16px; font-weight: 500; }
  .status-waiting { background: #FFF9E6; color: #B25000; }
  .status-success { background: #E8F9ED; color: #1B7A3D; }
  .hint { color: #86868b; font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <h1>TE System Login</h1>
  <p class="subtitle">Complete the login, then send the token back</p>

  <div class="card">
    <div class="step-title"><span class="step-num">1</span>Log in to TE System</div>
    <p>Switch to the TE login tab that was just opened and complete your login.</p>
    <p class="hint">If the tab didn't open, <a href="${CONFIG.LOGIN_URL}" target="_blank">click here</a>.</p>
  </div>

  <div class="card">
    <div class="step-title"><span class="step-num">2</span>Send Token (choose one method)</div>

    <p><strong>Method A</strong> — Console command (recommended)</p>
    <p style="margin-top:8px;">On the <strong>TE page</strong>, press <kbd>F12</kbd> or <kbd>Cmd+Option+J</kbd> to open the console, then paste:</p>
    <div class="command-box" id="cmd">${fetchCmd}</div>
    <button class="btn btn-primary" id="copyBtn" onclick="copyCmd()">Copy Command</button>

    <div class="divider">— or —</div>

    <p><strong>Method B</strong> — Paste token manually</p>
    <p style="margin-top:8px;">In the TE page console, run: <code>copy(localStorage.getItem('ACCESS_TOKEN'))</code></p>
    <p style="margin-top:4px;">Then paste the token here:</p>
    <textarea id="tokenInput" placeholder="Paste token here..." style="margin-top:8px;"></textarea>
    <br><br>
    <button class="btn btn-primary" onclick="submitToken()">Submit Token</button>
  </div>

  <div id="status" class="status status-waiting">Waiting for token...</div>
</div>

<script>
function copyCmd() {
  const text = document.getElementById('cmd').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    btn.className = 'btn btn-success';
    setTimeout(() => { btn.textContent = 'Copy Command'; btn.className = 'btn btn-primary'; }, 2000);
  });
}

function submitToken() {
  const token = document.getElementById('tokenInput').value.trim();
  if (!token) { alert('Please paste a token first.'); return; }
  fetch('/token', { method: 'POST', body: token })
    .then(r => { if (!r.ok) throw new Error('Server rejected token'); showSuccess(); })
    .catch(e => alert('Error: ' + e.message));
}

function showSuccess() {
  const el = document.getElementById('status');
  el.className = 'status status-success';
  el.textContent = '\\u2705 Token received! You can close this page.';
}

// Poll for status every 2 seconds
setInterval(() => {
  fetch('/status').then(r => r.json()).then(data => {
    if (data.received) showSuccess();
  }).catch(() => {});
}, 2000);
</script>
</body>
</html>`;
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
