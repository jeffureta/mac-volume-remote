import { describe, it, expect } from "vitest";
import { clampVolume, parseClientCommand, isAudioState } from "../src/shared/protocol.js";

describe("Protocol & Domain Invariants", () => {
  it("clamps volume values correctly between 0 and 100", () => {
    expect(clampVolume(-10)).toBe(0);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(42.4)).toBe(42);
    expect(clampVolume(42.6)).toBe(43);
    expect(clampVolume(100)).toBe(100);
    expect(clampVolume(150)).toBe(100);
    expect(clampVolume(NaN)).toBe(0);
  });

  it("validates and parses ClientCommand payloads safely", () => {
    expect(parseClientCommand({ type: "getState" })).toEqual({ type: "getState" });
    expect(parseClientCommand({ type: "setVolume", volume: 65 })).toEqual({ type: "setVolume", volume: 65 });
    expect(parseClientCommand({ type: "setVolume", volume: 200 })).toEqual({ type: "setVolume", volume: 100 });
    expect(parseClientCommand({ type: "adjustVolume", delta: -5 })).toEqual({ type: "adjustVolume", delta: -5 });
    expect(parseClientCommand({ type: "setMuted", muted: true })).toEqual({ type: "setMuted", muted: true });
    expect(parseClientCommand({ type: "toggleMute" })).toEqual({ type: "toggleMute" });
    expect(parseClientCommand({ type: "invalid" })).toBeNull();
    expect(parseClientCommand(null)).toBeNull();
  });

  it("validates AudioState structure", () => {
    expect(isAudioState({ volume: 50, muted: false, outputDevice: "Speakers" })).toBe(true);
    expect(isAudioState({ volume: -1, muted: false, outputDevice: "Speakers" })).toBe(false);
    expect(isAudioState({ volume: 50, muted: "no", outputDevice: "Speakers" })).toBe(false);
  });
});
