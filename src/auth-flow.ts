import puppeteer, { type Page } from 'puppeteer';
import { promises as fs, statSync } from 'fs';
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
   * Launch Puppeteer browser, navigate to login page,
   * wait for user to login, and extract bearer token from localStorage.
   */
  private async browserLogin(): Promise<string> {
    await fs.mkdir(CONFIG.CHROME_PROFILE_DIR, { recursive: true });

    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: CONFIG.CHROME_PROFILE_DIR,
      executablePath: this.findChromePath(),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'networkidle2' });

      // Check if already logged in (token exists in localStorage)
      const existingToken = await page.evaluate((key: string) => {
        return localStorage.getItem(key);
      }, CONFIG.BEARER_TOKEN_KEY);

      if (existingToken) {
        log('Already logged in (token found in localStorage).');
        return existingToken;
      }

      // Wait for user to login
      log('Waiting for user to login in the browser window...');
      log('(Login window will timeout in 5 minutes)');

      const token = await this.waitForToken(page);
      return token;
    } finally {
      await browser.close();
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
   * Poll localStorage every second until ACCESS_TOKEN appears.
   */
  private async waitForToken(page: Page): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < CONFIG.LOGIN_TIMEOUT_MS) {
      try {
        const token = await page.evaluate((key: string) => {
          return localStorage.getItem(key);
        }, CONFIG.BEARER_TOKEN_KEY);

        if (token) {
          log('Login detected! Token found in localStorage.');
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
