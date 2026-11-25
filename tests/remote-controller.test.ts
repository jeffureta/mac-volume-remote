import { describe, it, expect, beforeEach } from "vitest";
import { RemoteController } from "../src/client/remote-controller.js";

describe("RemoteController (Client state, pillar math, echo guard)", () => {
  let controller: RemoteController;
  let sentCommands: any[];

  beforeEach(() => {
    sentCommands = [];
    controller = new RemoteController({
      sendCommand: (cmd) => sentCommands.push(cmd)
    });
  });

  it("calculates vertical pillar volume from client coordinates (bottom=0, top=100)", () => {
    // track height 400px, top at 100, bottom at 500
    const trackRect = { top: 100, bottom: 500, height: 400 };

    // pointer at top (100) -> 100%
    expect(controller.calculateVolumeFromPointerY(100, trackRect)).toBe(100);

    // pointer at bottom (500) -> 0%
    expect(controller.calculateVolumeFromPointerY(500, trackRect)).toBe(0);

    // pointer in middle (300) -> 50%
    expect(controller.calculateVolumeFromPointerY(300, trackRect)).toBe(50);

    // pointer above top (50) -> clamped 100%
    expect(controller.calculateVolumeFromPointerY(50, trackRect)).toBe(100);
  });

  it("suppresses stale inbound server echoes while user is actively dragging", () => {
    controller.applyServerState({ volume: 40, muted: false, outputDevice: "Speakers" });
    expect(controller.getCurrentDisplayVolume()).toBe(40);

    controller.startDrag(75);
    expect(controller.getCurrentDisplayVolume()).toBe(75);
    expect(sentCommands).toEqual([{ type: "setVolume", volume: 75 }]);

    // Stale server echo comes back (e.g. 40 or 50 from previous lag)
    controller.applyServerState({ volume: 45, muted: false, outputDevice: "Speakers" });
    // User display MUST stay at 75 while dragging
    expect(controller.getCurrentDisplayVolume()).toBe(75);

    controller.endDrag();
    // After ending drag, next authoritative server update is accepted
    controller.applyServerState({ volume: 75, muted: false, outputDevice: "Speakers" });
    expect(controller.getCurrentDisplayVolume()).toBe(75);
  });

  it("dispatches step and preset commands", () => {
    controller.stepVolume(5);
    expect(sentCommands[0]).toEqual({ type: "adjustVolume", delta: 5 });

    controller.setPreset(25);
    expect(sentCommands[1]).toEqual({ type: "setVolume", volume: 25 });

    controller.toggleMute();
    expect(sentCommands[2]).toEqual({ type: "toggleMute" });
  });
});
