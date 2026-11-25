import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

export interface StoredCredentials {
  pin: string;
  bootstrapToken: string;
  sessionTokens: string[];
  createdAt: string;
}

export interface PairingAuthOptions {
  maxAttempts?: number;
  lockoutMs?: number;
}

export class PairingAuthService {
  private configPath: string;
  private creds: StoredCredentials;
  private maxAttempts: number;
  private lockoutMs: number;
  private failedAttempts: Map<string, { count: number; lastFailedAt: number }> = new Map();

  constructor(customPath?: string, options: PairingAuthOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 60_000;
    this.configPath = customPath ?? path.join(os.homedir(), ".config", "mac-volume-remote", "config.json");
    this.creds = this.loadOrGenerateCredentials();
  }

  public getCredentials(): StoredCredentials {
    return { ...this.creds };
  }

  public rotateCredentials(): StoredCredentials {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    const bootstrapToken = crypto.randomBytes(16).toString("hex");
    const initialSessionToken = crypto.randomBytes(32).toString("hex");

    this.creds = {
      pin,
      bootstrapToken,
      sessionTokens: [initialSessionToken],
      createdAt: new Date().toISOString()
    };
    this.saveCredentials();
    return { ...this.creds };
  }

  public verifyPinAndIssueToken(inputPin: string, clientIp: string): string | null {
    if (this.isRateLimited(clientIp)) {
      return null;
    }

    if (this.safeCompare(inputPin, this.creds.pin)) {
      this.clearFailedAttempts(clientIp);
      const newToken = crypto.randomBytes(32).toString("hex");
      this.creds.sessionTokens.push(newToken);
      this.saveCredentials();
      return newToken;
    }

    this.recordFailedAttempt(clientIp);
    return null;
  }

  public verifyBootstrapAndIssueToken(inputBootstrap: string, clientIp: string): string | null {
    if (this.isRateLimited(clientIp)) {
      return null;
    }

    if (this.safeCompare(inputBootstrap, this.creds.bootstrapToken)) {
      this.clearFailedAttempts(clientIp);
      const newToken = crypto.randomBytes(32).toString("hex");
      this.creds.sessionTokens.push(newToken);
      this.saveCredentials();
      return newToken;
    }

    this.recordFailedAttempt(clientIp);
    return null;
  }

  public validateSessionToken(token: string): boolean {
    if (!token || typeof token !== "string") return false;
    return this.creds.sessionTokens.some(savedToken => this.safeCompare(token, savedToken));
  }

  private isRateLimited(ip: string): boolean {
    const record = this.failedAttempts.get(ip);
    if (!record) return false;
    if (Date.now() - record.lastFailedAt > this.lockoutMs) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return record.count >= this.maxAttempts;
  }

  private recordFailedAttempt(ip: string) {
    const now = Date.now();
    const record = this.failedAttempts.get(ip);
    if (!record || now - record.lastFailedAt > this.lockoutMs) {
      this.failedAttempts.set(ip, { count: 1, lastFailedAt: now });
    } else {
      record.count += 1;
      record.lastFailedAt = now;
    }
  }

  private clearFailedAttempts(ip: string) {
    this.failedAttempts.delete(ip);
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a || "");
    const bufB = Buffer.from(b || "");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private loadOrGenerateCredentials(): StoredCredentials {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.pin && parsed.bootstrapToken && Array.isArray(parsed.sessionTokens)) {
          return parsed;
        }
      }
    } catch {
      // Fall through to regenerate
    }

    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    const bootstrapToken = crypto.randomBytes(16).toString("hex");
    const initialSessionToken = crypto.randomBytes(32).toString("hex");

    const creds: StoredCredentials = {
      pin,
      bootstrapToken,
      sessionTokens: [initialSessionToken],
      createdAt: new Date().toISOString()
    };

    this.creds = creds;
    this.saveCredentials();
    return creds;
  }

  private saveCredentials() {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.creds, null, 2), {
      encoding: "utf-8",
      mode: 0o600
    });
    fs.chmodSync(this.configPath, 0o600);
  }
}
