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

export type AuthResult =
  | { ok: true; token: string }
  | {
      ok: false;
      code: "E_PAIR_INVALID_PIN" | "E_PAIR_INVALID_BOOTSTRAP" | "E_PAIR_RATE_LIMITED";
      error: string;
      retryAfterSec?: number;
    };

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

  public authenticatePin(inputPin: string, clientIp: string): AuthResult {
    const rateLimitCheck = this.checkRateLimit(clientIp);
    if (rateLimitCheck.limited) {
      return {
        ok: false,
        code: "E_PAIR_RATE_LIMITED",
        error: `Too many failed pairing attempts. Please wait ${rateLimitCheck.retryAfterSec} seconds.`,
        retryAfterSec: rateLimitCheck.retryAfterSec
      };
    }

    if (this.safeCompare(inputPin, this.creds.pin)) {
      this.clearFailedAttempts(clientIp);
      const newToken = crypto.randomBytes(32).toString("hex");
      this.creds.sessionTokens.push(newToken);
      this.saveCredentials();
      return { ok: true, token: newToken };
    }

    this.recordFailedAttempt(clientIp);
    return {
      ok: false,
      code: "E_PAIR_INVALID_PIN",
      error: "Incorrect 4-digit PIN. Please check the PIN printed in your Mac terminal."
    };
  }

  public authenticateBootstrap(inputBootstrap: string, clientIp: string): AuthResult {
    const rateLimitCheck = this.checkRateLimit(clientIp);
    if (rateLimitCheck.limited) {
      return {
        ok: false,
        code: "E_PAIR_RATE_LIMITED",
        error: `Too many failed pairing attempts. Please wait ${rateLimitCheck.retryAfterSec} seconds.`,
        retryAfterSec: rateLimitCheck.retryAfterSec
      };
    }

    if (this.safeCompare(inputBootstrap, this.creds.bootstrapToken)) {
      this.clearFailedAttempts(clientIp);
      const newToken = crypto.randomBytes(32).toString("hex");
      this.creds.sessionTokens.push(newToken);
      this.saveCredentials();
      return { ok: true, token: newToken };
    }

    this.recordFailedAttempt(clientIp);
    return {
      ok: false,
      code: "E_PAIR_INVALID_BOOTSTRAP",
      error: "QR pairing token is invalid or expired. Scan a fresh QR code from your Mac terminal."
    };
  }

  public verifyPinAndIssueToken(inputPin: string, clientIp: string): string | null {
    const res = this.authenticatePin(inputPin, clientIp);
    return res.ok ? res.token : null;
  }

  public verifyBootstrapAndIssueToken(inputBootstrap: string, clientIp: string): string | null {
    const res = this.authenticateBootstrap(inputBootstrap, clientIp);
    return res.ok ? res.token : null;
  }

  public validateSessionToken(token: string): boolean {
    if (!token || typeof token !== "string") return false;
    return this.creds.sessionTokens.some(savedToken => this.safeCompare(token, savedToken));
  }

  private checkRateLimit(ip: string): { limited: boolean; retryAfterSec?: number } {
    const record = this.failedAttempts.get(ip);
    if (!record) return { limited: false };
    const elapsed = Date.now() - record.lastFailedAt;
    if (elapsed > this.lockoutMs) {
      this.failedAttempts.delete(ip);
      return { limited: false };
    }
    if (record.count >= this.maxAttempts) {
      const remainingMs = this.lockoutMs - elapsed;
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    return { limited: false };
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
      // Regenerate
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
