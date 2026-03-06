import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { exec, spawn } from 'child_process';
import { CONFIG } from './config.js';
import { TokenManager } from './token-manager.js';

function log(msg: string): void {
  process.stderr.write(`[mcp-te-server] ${msg}\n`);
}

// Chromium-based browsers that support AppleScript's `execute ... javascript`
const CHROMIUM_BROWSERS = [
  'Google Chrome',
  'Google Chrome Canary',
  'Brave Browser',
  'Microsoft Edge',
  'Arc',
];

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
   */
  async reauthenticate(): Promise<string> {
    log('Re-authenticating...');

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

    const newBearerToken = await this.browserLogin();
    const mcpToken = await this.obtainMcpToken(newBearerToken);
    await this.tokenManager.setTokens(newBearerToken, mcpToken);
    log('Re-authentication complete via browser login.');

    return mcpToken;
  }

  /**
   * Open TE login in default browser, then auto-extract token.
   *
   * On macOS: uses AppleScript to read localStorage from the browser tab directly.
   * On other platforms: falls back to a local guide page.
   */
  private async browserLogin(): Promise<string> {
    this.openInDefaultBrowser(CONFIG.LOGIN_URL);
    log('TE login page opened in your default browser. Please log in...');

    // On macOS, try fully automatic extraction via AppleScript
    if (process.platform === 'darwin') {
      try {
        const token = await this.pollTokenMacOS();
        if (token) return token;
      } catch (error: any) {
        log(`Auto-extraction not available: ${error.message}`);
        log('Falling back to guide page...');
      }
    }

    // Fallback: guide page with manual instructions
    return this.loginViaGuidePage();
  }

  // ─── macOS AppleScript auto-extraction ─────────────────────────────

  /**
   * Poll all known browsers via AppleScript to find the TE tab
   * and read ACCESS_TOKEN from localStorage. Fully automatic — no user
   * interaction needed beyond logging in.
   */
  private async pollTokenMacOS(): Promise<string | null> {
    const startTime = Date.now();
    let jsErrorCount = 0;

    while (Date.now() - startTime < CONFIG.LOGIN_TIMEOUT_MS) {
      // Try Chromium-based browsers
      for (const browser of CHROMIUM_BROWSERS) {
        const result = await this.extractTokenFromChromium(browser);
        if (result === 'JS_NOT_ALLOWED') {
          jsErrorCount++;
          if (jsErrorCount >= 2) {
            throw new Error(
              'Chrome needs "Allow JavaScript from Apple Events" enabled. ' +
              'Go to Chrome menu → View → Developer → Allow JavaScript from Apple Events.',
            );
          }
        }
        if (result && result !== 'JS_NOT_ALLOWED') return result;
      }

      // Try Safari
      const safariResult = await this.extractTokenFromSafari();
      if (safariResult) return safariResult;

      await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
    }

    return null;
  }

  /**
   * Try to extract token from a Chromium-based browser via AppleScript.
   * Returns the token string, 'JS_NOT_ALLOWED' if JavaScript execution is blocked,
   * or null if not found / browser not running.
   */
  private extractTokenFromChromium(browserName: string): Promise<string | null> {
    const teUrl = CONFIG.BASE_URL;
    const script = `
tell application "System Events"
  if not (exists process "${browserName}") then return "NOT_RUNNING"
end tell
tell application "${browserName}"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "${teUrl}" then
        try
          set tokenVal to execute t javascript "localStorage.getItem('ACCESS_TOKEN')"
          if tokenVal is not missing value and tokenVal is not "" and tokenVal is not "null" then
            set urlVal to URL of t
            if urlVal contains "#/" and urlVal does not end with "#/login" then
              return tokenVal
            end if
          end if
        on error errMsg
          if errMsg contains "not allowed" or errMsg contains "not permitted" then
            return "JS_NOT_ALLOWED"
          end if
        end try
      end if
    end repeat
  end repeat
end tell
return ""
`;
    return this.runAppleScript(script);
  }

  /**
   * Try to extract token from Safari via AppleScript.
   */
  private extractTokenFromSafari(): Promise<string | null> {
    const teUrl = CONFIG.BASE_URL;
    const script = `
tell application "System Events"
  if not (exists process "Safari") then return ""
end tell
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "${teUrl}" then
        try
          set tokenVal to do JavaScript "localStorage.getItem('ACCESS_TOKEN')" in t
          if tokenVal is not missing value and tokenVal is not "" and tokenVal is not "null" then
            set urlVal to URL of t
            if urlVal contains "#/" and urlVal does not end with "#/login" then
              return tokenVal
            end if
          end if
        end try
      end if
    end repeat
  end repeat
end tell
return ""
`;
    return this.runAppleScript(script);
  }

  /**
   * Execute an AppleScript and return the cleaned result.
   * Uses spawn + stdin to avoid shell escaping issues.
   */
  private runAppleScript(script: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', () => {
        const result = stdout.trim();
        if (!result || result === 'NOT_RUNNING' || result === 'missing value') {
          resolve(null);
          return;
        }
        if (result === 'JS_NOT_ALLOWED') {
          resolve('JS_NOT_ALLOWED');
          return;
        }
        const token = this.cleanToken(result);
        if (token) {
          log(`Token auto-extracted via AppleScript: ${token.substring(0, 8)}...`);
        }
        resolve(token);
      });

      // Handle spawn errors (e.g., osascript not found)
      proc.on('error', () => {
        resolve(null);
      });

      proc.stdin.write(script);
      proc.stdin.end();
    });
  }

  // ─── Fallback: guide page ──────────────────────────────────────────

  /**
   * Start a local HTTP server with a guide page for manual token transfer.
   * Used as fallback when AppleScript auto-extraction is not available.
   */
  private loginViaGuidePage(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }

        if (req.method === 'GET' && (req.url === '/' || req.url === '/guide')) {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.buildGuidePage(port));
          return;
        }

        if (req.method === 'GET' && req.url === '/status') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ received: resolved }));
          return;
        }

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
        this.openInDefaultBrowser(`http://127.0.0.1:${port}/guide`);
        log(`Guide page opened: http://127.0.0.1:${port}/guide`);
        log('Waiting for token...');
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          server.close();
          reject(new Error('Login timeout: no token received within 5 minutes.'));
        }
      }, CONFIG.LOGIN_TIMEOUT_MS);

      server.on('close', () => clearTimeout(timer));
    });
  }

  private buildGuidePage(port: number): string {
    const fetchCmd = `fetch('http://127.0.0.1:${port}/token',{method:'POST',body:localStorage.getItem('ACCESS_TOKEN')})`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>TE Login - Token Transfer</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #f5f5f7; }
  h1 { text-align: center; margin-bottom: 32px; }
  .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .cmd { background: #1e1e1e; color: #d4d4d4; padding: 14px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 12px 0; }
  .btn { padding: 10px 20px; border-radius: 8px; border: none; font-size: 15px; cursor: pointer; background: #007AFF; color: white; }
  textarea { width: 100%; height: 56px; border: 2px solid #d2d2d7; border-radius: 8px; padding: 10px; font-family: monospace; }
  .status { text-align: center; padding: 16px; border-radius: 12px; }
  .waiting { background: #FFF9E6; color: #B25000; }
  .success { background: #E8F9ED; color: #1B7A3D; }
</style>
</head>
<body>
<h1>TE Login Token Transfer</h1>
<div class="card">
  <p><strong>Step 1:</strong> Log in to TE in the other tab.</p>
  <p><strong>Step 2:</strong> On the TE page, press F12 / Cmd+Option+J, then paste:</p>
  <div class="cmd" id="cmd">${fetchCmd}</div>
  <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})">Copy</button>
  <hr style="margin:16px 0;border:none;border-top:1px solid #eee">
  <p>Or paste token directly:</p>
  <textarea id="t" placeholder="Paste token here..."></textarea><br><br>
  <button class="btn" onclick="fetch('/token',{method:'POST',body:document.getElementById('t').value.trim()}).then(r=>{if(!r.ok)throw 0;showOK()}).catch(()=>alert('Invalid token'))">Submit</button>
</div>
<div id="s" class="status waiting">Waiting for token...</div>
<script>
function showOK(){document.getElementById('s').className='status success';document.getElementById('s').textContent='Token received! Close this page.'}
setInterval(()=>fetch('/status').then(r=>r.json()).then(d=>{if(d.received)showOK()}).catch(()=>{}),2000);
</script>
</body></html>`;
  }

  // ─── Utilities ─────────────────────────────────────────────────────

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
        log(`Could not open browser: ${error.message}`);
        log(`Please open manually: ${url}`);
      }
    });
  }

  /**
   * Clean a token value from localStorage.
   * Values may be JSON-encoded strings (e.g., '"abc"' with embedded quotes).
   */
  private cleanToken(raw: string | null): string | null {
    if (!raw) return null;
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

        const result = (await response.json()) as {
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

    throw new Error(
      `Failed to obtain mcpToken after ${CONFIG.MAX_RETRIES} attempts: ${lastError?.message}`,
    );
  }
}
