import { promises as fs } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config.js';

export interface TokenCache {
  bearerToken?: string;
  mcpToken?: string;
  obtainedAt?: number;
}

export class TokenManager {
  private cache: TokenCache = {};

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG.TOKEN_FILE, 'utf-8');
      this.cache = JSON.parse(data);
    } catch (error) {
      // File doesn't exist or is invalid, start with empty cache
      this.cache = {};
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(dirname(CONFIG.TOKEN_FILE), { recursive: true });
    await fs.writeFile(CONFIG.TOKEN_FILE, JSON.stringify(this.cache, null, 2), {
      mode: 0o600, // Only user can read/write
    });
  }

  getBearerToken(): string | undefined {
    return this.cache.bearerToken;
  }

  getMcpToken(): string | undefined {
    return this.cache.mcpToken;
  }

  async setBearerToken(token: string): Promise<void> {
    this.cache.bearerToken = token;
    await this.save();
  }

  async setMcpToken(token: string): Promise<void> {
    this.cache.mcpToken = token;
    this.cache.obtainedAt = Date.now();
    await this.save();
  }

  async setTokens(bearerToken: string, mcpToken: string): Promise<void> {
    this.cache.bearerToken = bearerToken;
    this.cache.mcpToken = mcpToken;
    this.cache.obtainedAt = Date.now();
    await this.save();
  }

  async clear(): Promise<void> {
    this.cache = {};
    await this.save();
  }
}
