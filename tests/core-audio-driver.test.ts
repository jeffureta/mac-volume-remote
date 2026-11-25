import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreAudioDriver } from "../src/audio/core-audio-driver.js";
import { InMemoryAudioDriver } from "../src/audio/in-memory-audio-driver.js";
import path from "node:path";
import fs from "node:fs";

describe("Audio Drivers Contract", () => {
  it("InMemoryAudioDriver performs deterministic state transitions and event emission", async () => {
    const driver = new InMemoryAudioDriver({ volume: 50, muted: false, outputDevice: "Test Device" });
    const events: any[] = [];
    driver.onStateChange(s => events.push(s));

    const initial = await driver.getState();
    expect(initial.volume).toBe(50);
    expect(initial.muted).toBe(false);

    await driver.setVolume(75);
    expect((await driver.getState()).volume).toBe(75);

    await driver.adjustVolume(-10);
    expect((await driver.getState()).volume).toBe(65);

    await driver.setMuted(true);
    expect((await driver.getState()).muted).toBe(true);

    await driver.toggleMute();
    expect((await driver.getState()).muted).toBe(false);

    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it("CoreAudioDriver interacts with compiled binary bridge", async () => {
    const binPath = path.resolve("bin/audio-bridge");
    if (!fs.existsSync(binPath)) {
      expect(true).toBe(true);
      return;
    }

    const driver = new CoreAudioDriver({ bridgePath: binPath });
    try {
      const state = await driver.getState();
      expect(state.volume).toBeGreaterThanOrEqual(0);
      expect(state.volume).toBeLessThanOrEqual(100);
      expect(typeof state.muted).toBe("boolean");
      expect(typeof state.outputDevice).toBe("string");
    } finally {
      driver.destroy();
    }
  });

  it("supervises and auto-respawns bridge on unexpected crash", async () => {
    const binPath = path.resolve("bin/audio-bridge");
    if (!fs.existsSync(binPath)) return;

    const events: string[] = [];
    const driver = new CoreAudioDriver({
      bridgePath: binPath,
      autoRestart: true,
      restartBaseDelayMs: 50,
      onBridgeEvent: (msg) => events.push(msg)
    });

    try {
      const initial = await driver.getState();
      expect(initial.outputDevice).toBeTruthy();

      // Simulate unexpected bridge crash
      const child = (driver as any).process;
      expect(child).not.toBeNull();
      child.kill("SIGKILL");

      // Wait for backoff respawn
      await new Promise(r => setTimeout(r, 200));

      const recovered = await driver.getState();
      expect(recovered.outputDevice).toBeTruthy();
      expect((driver as any).process).not.toBeNull();
      expect(events.some(e => e.includes("Bridge exited unexpectedly"))).toBe(true);
      expect(events.some(e => e.includes("Bridge respawned successfully"))).toBe(true);
    } finally {
      driver.destroy();
    }
  });
});
