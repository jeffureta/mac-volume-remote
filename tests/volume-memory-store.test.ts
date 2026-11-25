import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VolumeMemoryStore } from "../src/state/volume-memory-store.js";
import { CoreAudioDriver } from "../src/audio/core-audio-driver.js";

describe("VolumeMemoryStore & CoreAudioDriver initial state", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-vol-store-"));
    statePath = path.join(tmpDir, "nested", "volume-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when state file does not exist or contains corrupt JSON", () => {
    const store = new VolumeMemoryStore(statePath);
    expect(store.load()).toBeNull();

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not-valid-json", "utf-8");
    expect(store.load()).toBeNull();
  });

  it("saves and loads AudioState atomically with ISO updatedAt timestamp", () => {
    const store = new VolumeMemoryStore(statePath);
    const saved = store.save({
      volume: 74,
      muted: true,
      outputDevice: "Studio Display Speakers"
    });

    expect(saved.volume).toBe(74);
    expect(saved.muted).toBe(true);
    expect(saved.outputDevice).toBe("Studio Display Speakers");
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);

    const loaded = store.load();
    expect(loaded).toEqual(saved);

    // Atomic overwrite on subsequent saves without leftover .tmp file
    const updated = store.save({
      volume: 33,
      muted: false,
      outputDevice: "MacBook Air Speakers"
    });
    expect(store.load()).toEqual(updated);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
  });

  it("clamps out-of-range volume values on save and load", () => {
    const store = new VolumeMemoryStore(statePath);
    const saved = store.save({
      volume: 145.6,
      muted: false,
      outputDevice: "Speakers"
    });
    expect(saved.volume).toBe(100);

    fs.writeFileSync(
      statePath,
      JSON.stringify({ volume: -20, muted: false, outputDevice: "Speakers", updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    expect(store.load()?.volume).toBe(0);
  });

  it("boots CoreAudioDriver with remembered initialState instead of hardcoded 50%", async () => {
    const driver = new CoreAudioDriver({
      bridgePath: path.join(tmpDir, "non-existent-bridge"),
      initialState: {
        volume: 82,
        muted: true,
        outputDevice: "Living Room HomePod"
      }
    });

    const state = await driver.getState();
    expect(state).toEqual({
      volume: 82,
      muted: true,
      outputDevice: "Living Room HomePod"
    });
    driver.destroy();
  });

  it("coalesces rapid scheduleSave writes into a single disk write on timeout", async () => {
    const store = new VolumeMemoryStore(statePath);
    expect(store.hasPendingWrite()).toBe(false);

    store.scheduleSave({ volume: 10, muted: false, outputDevice: "Speakers" }, 50);
    store.scheduleSave({ volume: 20, muted: false, outputDevice: "Speakers" }, 50);
    store.scheduleSave({ volume: 30, muted: false, outputDevice: "Speakers" }, 50);

    expect(store.hasPendingWrite()).toBe(true);
    // Before timer fires, disk file is still empty or non-existent
    expect(store.load()).toBeNull();

    // Wait for debounce timer to fire
    await new Promise(r => setTimeout(r, 80));

    expect(store.hasPendingWrite()).toBe(false);
    expect(store.load()?.volume).toBe(30);
  });

  it("immediately writes latest state on flush() and cancels pending timer", () => {
    const store = new VolumeMemoryStore(statePath);
    store.scheduleSave({ volume: 88, muted: true, outputDevice: "AirPods" }, 500);

    expect(store.hasPendingWrite()).toBe(true);
    const saved = store.flush();

    expect(saved).not.toBeNull();
    expect(saved?.volume).toBe(88);
    expect(store.hasPendingWrite()).toBe(false);
    expect(store.load()?.volume).toBe(88);
  });
});
