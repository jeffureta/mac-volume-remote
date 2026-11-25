import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PairingAuthService } from "../src/auth/pairing-auth.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("PairingAuthService", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-auth-test-"));
    configPath = path.join(tmpDir, "config.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates deterministic credentials and persists with 0600 permissions", () => {
    const auth = new PairingAuthService(configPath);
    const creds = auth.getCredentials();

    expect(creds.pin).toMatch(/^\d{4}$/);
    expect(creds.bootstrapToken).toHaveLength(32);
    expect(creds.sessionTokens.length).toBeGreaterThan(0);

    const stat = fs.statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("authenticates valid PIN and issues a session token", () => {
    const auth = new PairingAuthService(configPath);
    const creds = auth.getCredentials();

    const token = auth.verifyPinAndIssueToken(creds.pin, "192.168.1.50");
    expect(token).toBeTruthy();
    expect(auth.validateSessionToken(token!)).toBe(true);
  });

  it("authenticates valid bootstrap token and issues a session token", () => {
    const auth = new PairingAuthService(configPath);
    const creds = auth.getCredentials();

    const token = auth.verifyBootstrapAndIssueToken(creds.bootstrapToken, "192.168.1.50");
    expect(token).toBeTruthy();
    expect(auth.validateSessionToken(token!)).toBe(true);
  });

  it("enforces rate limiting on repeated failed attempts per IP", () => {
    const auth = new PairingAuthService(configPath, { maxAttempts: 3, lockoutMs: 1000 });
    const ip = "192.168.1.100";

    expect(auth.verifyPinAndIssueToken("0000", ip)).toBeNull();
    expect(auth.verifyPinAndIssueToken("0001", ip)).toBeNull();
    expect(auth.verifyPinAndIssueToken("0002", ip)).toBeNull();

    const creds = auth.getCredentials();
    expect(auth.verifyPinAndIssueToken(creds.pin, ip)).toBeNull();
  });

  it("returns structured AuthResult with error codes for invalid PIN and rate limit", () => {
    const auth = new PairingAuthService(configPath, { maxAttempts: 2, lockoutMs: 60000 });
    const ip = "192.168.0.50";

    const res1 = auth.authenticatePin("0000", ip);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.code).toBe("E_PAIR_INVALID_PIN");
    }

    const res2 = auth.authenticatePin("0001", ip);
    expect(res2.ok).toBe(false);

    const res3 = auth.authenticatePin("1234", ip);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.code).toBe("E_PAIR_RATE_LIMITED");
      expect(res3.retryAfterSec).toBeGreaterThan(0);
    }
  });
});
