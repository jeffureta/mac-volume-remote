export type VolumePercent = number;

export interface AudioState {
  volume: VolumePercent;
  muted: boolean;
  outputDevice: string;
}

export type ClientCommand =
  | { type: "getState" }
  | { type: "setVolume"; volume: VolumePercent }
  | { type: "adjustVolume"; delta: number }
  | { type: "setMuted"; muted: boolean }
  | { type: "toggleMute" };

export type ServerMessage =
  | { type: "state"; state: AudioState; hostName: string }
  | { type: "error"; code: string; message: string };

export function clampVolume(value: number): VolumePercent {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function isAudioState(obj: any): obj is AudioState {
  if (!obj || typeof obj !== "object") return false;
  return (
    typeof obj.volume === "number" &&
    obj.volume >= 0 &&
    obj.volume <= 100 &&
    typeof obj.muted === "boolean" &&
    typeof obj.outputDevice === "string"
  );
}

export function parseClientCommand(raw: any): ClientCommand | null {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
    return null;
  }

  switch (raw.type) {
    case "getState":
      return { type: "getState" };
    case "setVolume":
      return { type: "setVolume", volume: clampVolume(raw.volume) };
    case "adjustVolume": {
      const delta = typeof raw.delta === "number" && Number.isFinite(raw.delta) ? raw.delta : 0;
      return { type: "adjustVolume", delta };
    }
    case "setMuted":
      return { type: "setMuted", muted: Boolean(raw.muted) };
    case "toggleMute":
      return { type: "toggleMute" };
    default:
      return null;
  }
}
