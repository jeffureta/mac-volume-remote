import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppServer } from "../src/server/app-server.js";
import { InMemoryAudioDriver } from "../src/audio/in-memory-audio-driver.js";
import { PairingAuthService } from "../src/auth/pairing-auth.js";
import { WebSocket } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("AppServer (HTTP pairing & WebSocket 2-way sync)", () => {
  let tmpDir: string;
  let authService: PairingAuthService;
  let audioDriver: InMemoryAudioDriver;
  let server: AppServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-server-test-"));
    const configPath = path.join(tmpDir, "config.json");
    authService = new PairingAuthService(configPath);
    audioDriver = new InMemoryAudioDriver({ volume: 55, muted: false, outputDevice: "Test Air" });
    server = new AppServer({
      authService,
      audioDriver,
      hostName: "test-mac.local",
      port: 0
    });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exchanges valid PIN for sessionToken via HTTP POST /api/pair", async () => {
    const creds = authService.getCredentials();
    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: creds.pin })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeTruthy();
    expect(data.hostName).toBe("test-mac.local");
  });

  it("rejects WebSocket connection without valid token with 401 error event", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=invalid`);
    const errorPromise = new Promise<any>((resolve) => {
      ws.on("error", (err) => resolve(err));
    });

    const err = await errorPromise;
    expect(err.message).toContain("401");
  });

  it("establishes authorized WebSocket, pushes state, and executes volume command", async () => {
    const creds = authService.getCredentials();
    const validToken = creds.sessionTokens[0];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${validToken}`);

    const messages: any[] = [];
    const openPromise = new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });

    await openPromise;
    await new Promise(r => setTimeout(r, 60));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBe("state");
    expect(messages[0].state.volume).toBe(55);

    ws.send(JSON.stringify({ type: "setVolume", volume: 80 }));
    await new Promise(r => setTimeout(r, 60));

    expect((await audioDriver.getState()).volume).toBe(80);
    ws.close();
  });

  it("returns 200 OK with health status on GET /api/health", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.hostName).toBe("test-mac.local");
    expect(data.assetsReady).toBe(true);
  });

  it("verifies session token on GET /api/auth/verify", async () => {
    const creds = authService.getCredentials();
    const validToken = creds.sessionTokens[0];

    const resValid = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${validToken}` }
    });
    expect(resValid.status).toBe(200);
    const dataValid = await resValid.json();
    expect(dataValid.valid).toBe(true);

    const resInvalid = await fetch(`http://127.0.0.1:${port}/api/auth/verify`, {
      headers: { Authorization: "Bearer bad-token" }
    });
    expect(resInvalid.status).toBe(401);
    const dataInvalid = await resInvalid.json();
    expect(dataInvalid.code).toBe("E_AUTH_EXPIRED");
  });

  it("returns 429 when POST /api/pair is rate limited", async () => {
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: `000${i}` })
      });
    }

    const resLimited = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "9999" })
    });
    expect(resLimited.status).toBe(429);
    const data = await resLimited.json();
    expect(data.code).toBe("E_PAIR_RATE_LIMITED");
  });
});
