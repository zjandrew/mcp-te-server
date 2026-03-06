import puppeteer, { type Page } from 'puppeteer';
import { promises as fs, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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
   * 3. Puppeteer login → obtainMcpToken
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

    // Step 3: Full Puppeteer login flow
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
   * Launch browser, navigate to login page,
   * wait for user to login, and extract bearer token from localStorage.
   *
   * Strategy:
   * 1. Try to use the system Chrome's default profile (reuses existing login session)
   * 2. If Chrome is already running (profile locked), fall back to a separate profile
   */
  private async browserLogin(): Promise<string> {
    const chromePath = this.findChromePath();
    const defaultProfileDir = this.getDefaultChromeProfileDir();

    // Try default Chrome profile first (reuses existing login session)
    if (defaultProfileDir) {
      try {
        log(`Trying default Chrome profile: ${defaultProfileDir}`);
        return await this.launchAndExtractToken(chromePath, defaultProfileDir);
      } catch (error: any) {
        const msg = String(error?.message || '');
        if (msg.includes('lock') || msg.includes('already') || msg.includes('SingleInstance')) {
          log('Chrome is already running. Falling back to separate profile...');
        } else {
          log(`Default profile failed: ${msg}. Falling back to separate profile...`);
        }
      }
    }

    // Fall back to a separate profile
    await fs.mkdir(CONFIG.CHROME_PROFILE_DIR, { recursive: true });
    return await this.launchAndExtractToken(chromePath, CONFIG.CHROME_PROFILE_DIR);
  }

  /**
   * Launch Puppeteer with given profile, navigate to login, and extract token.
   */
  private async launchAndExtractToken(
    chromePath: string | undefined,
    profileDir: string,
  ): Promise<string> {
    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: profileDir,
      executablePath: chromePath,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'networkidle2' });

      // Read the initial token on page load (may be a stale placeholder).
      const rawInitialToken = await page.evaluate((key: string) => {
        return localStorage.getItem(key);
      }, CONFIG.BEARER_TOKEN_KEY);
      // localStorage values may be JSON-encoded strings (e.g., "\"abc\"")
      const initialToken = this.cleanToken(rawInitialToken);

      const currentUrl = page.url();

      // TE uses hash-based routing: /login#/panel/... means user is logged in
      // Check if the hash route indicates an authenticated page
      if (initialToken && this.isAuthenticatedUrl(currentUrl)) {
        log(`Already logged in (URL: ${currentUrl}). Token: ${initialToken.substring(0, 8)}...`);
        return initialToken;
      }

      // Wait for user to login — the token must either:
      // 1. Appear fresh (if there was no initial token), or
      // 2. Change from the initial placeholder value
      // 3. Or the URL changes to an authenticated route
      log('Waiting for user to login in the browser window...');
      log('(Login window will timeout in 5 minutes)');

      const token = await this.waitForToken(page, initialToken);
      return token;
    } finally {
      await browser.close();
    }
  }

  /**
   * Get the default Chrome user data directory for the current platform.
   */
  private getDefaultChromeProfileDir(): string | undefined {
    const platform = process.platform;
    const home = homedir();
    let profileDir: string;

    if (platform === 'darwin') {
      profileDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    } else if (platform === 'win32') {
      const localAppData = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local');
      profileDir = join(localAppData, 'Google', 'Chrome', 'User Data');
    } else {
      // Linux
      profileDir = join(home, '.config', 'google-chrome');
    }

    try {
      statSync(profileDir);
      return profileDir;
    } catch {
      log(`Default Chrome profile not found at ${profileDir}`);
      return undefined;
    }
  }

  /**
   * Find system Chrome executable path across macOS, Windows, and Linux.
   */
  private findChromePath(): string | undefined {
    const platform = process.platform;
    let candidates: string[] = [];

    if (platform === 'darwin') {
      candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];
    } else if (platform === 'win32') {
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || '';
      candidates = [
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ];
    } else {
      // Linux
      candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
    }

    for (const path of candidates) {
      try {
        statSync(path);
        log(`Using system browser: ${path}`);
        return path;
      } catch {
        // Not found, try next
      }
    }

    log('No system Chrome found, using Puppeteer bundled browser.');
    return undefined;
  }

  /**
   * Poll localStorage every second until ACCESS_TOKEN appears
   * AND the page has navigated away from /login (indicating real login).
   */
  private async waitForToken(page: Page, initialToken: string | null): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < CONFIG.LOGIN_TIMEOUT_MS) {
      try {
        const currentUrl = page.url();
        const rawToken = await page.evaluate((key: string) => {
          return localStorage.getItem(key);
        }, CONFIG.BEARER_TOKEN_KEY);
        const token = this.cleanToken(rawToken);

        // Accept the token when EITHER:
        // 1. The token changed from the initial placeholder (SPA login — URL may not change)
        // 2. The URL indicates an authenticated page (hash route is not /login)
        if (token && (token !== initialToken || this.isAuthenticatedUrl(currentUrl))) {
          log(`Login detected! Token: ${token.substring(0, 8)}... URL: ${currentUrl}`);
          return token;
        }
      } catch (error) {
        // Page might be navigating, ignore errors during polling
      }

      await new Promise((resolve) => setTimeout(resolve, CONFIG.POLL_INTERVAL_MS));
    }

    throw new Error('Login timeout: user did not complete login within 5 minutes.');
  }

  /**
   * Check if the URL indicates the user is on an authenticated page.
   * TE uses hash-based routing: /login#/panel/... means logged in,
   * /login#/login or /login (no hash) means not logged in.
   */
  private isAuthenticatedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hash = parsed.hash; // e.g., "#/panel/panel/3_43_0" or "#/login"
      // If there's a hash route and it's NOT a login page, user is authenticated
      if (hash && hash.length > 1) {
        const hashRoute = hash.substring(1); // Remove leading #
        return !hashRoute.startsWith('/login');
      }
      // No hash — check if pathname itself is /login
      return !parsed.pathname.includes('/login');
    } catch {
      return false;
    }
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
