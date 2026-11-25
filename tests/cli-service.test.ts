import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("CLI Daemon & Graceful Shutdown Integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("boots in --daemon mode without ANSI QR code and shuts down cleanly on SIGTERM with exit 0", async () => {
    const port = 4929 + Math.floor(Math.random() * 50);
    const cliPath = path.resolve("dist/cli.js");

    const child = spawn(
      process.execPath,
      [cliPath, "start", "--port", String(port), "--daemon"],
      {
        env: {
          ...process.env,
          HOME: tmpDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));

    // Wait until daemon prints ready line
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if (stdout.includes("Mac Volume Remote daemon ready") || stdout.includes("Server listening")) {
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    expect(ready).toBe(true);
    // In daemon mode, interactive ANSI box/QR shouldn't be printed
    expect(stdout).not.toContain("MAC VOLUME REMOTE - PAIRING");

    // Probe health endpoint
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.ok).toBe(true);

    // Send SIGTERM to simulate launchctl stop / system shutdown
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    child.kill("SIGTERM");
    const exitResult = await exitPromise;

    expect(exitResult.code).toBe(0);
    expect(stdout).toContain("Stopping server (SIGTERM)...");
  }, 10_000);
});
