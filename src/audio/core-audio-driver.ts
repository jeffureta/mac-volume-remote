import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { AudioDriver, AudioStateListener } from "./audio-driver.js";
import { AudioState, VolumePercent, clampVolume } from "../shared/protocol.js";

export interface CoreAudioDriverOptions {
  bridgePath?: string;
  initialState?: Partial<AudioState>;
}

export class CoreAudioDriver implements AudioDriver {
  private bridgePath: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private currentState: AudioState;
  private listeners: Set<AudioStateListener> = new Set();
  private pendingResolvers: Array<(state: AudioState) => void> = [];

  constructor(options: CoreAudioDriverOptions = {}) {
    this.bridgePath = options.bridgePath ?? path.resolve("bin/audio-bridge");
    this.currentState = {
      volume: clampVolume(options.initialState?.volume ?? 50),
      muted: Boolean(options.initialState?.muted ?? false),
      outputDevice: String(options.initialState?.outputDevice || "macOS Audio")
    };
    this.spawnBridge();
  }

  private spawnBridge() {
    if (!fs.existsSync(this.bridgePath)) {
      return;
    }

    this.process = spawn(this.bridgePath, [], { stdio: ["pipe", "pipe", "pipe"] });

    const rl = readline.createInterface({
      input: this.process.stdout,
      terminal: false
    });

    rl.on("line", (line: string) => {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.type === "state") {
          this.currentState = {
            volume: clampVolume(parsed.volume),
            muted: Boolean(parsed.muted),
            outputDevice: String(parsed.device || "macOS Audio")
          };
          this.emit();
          while (this.pendingResolvers.length > 0) {
            const resolver = this.pendingResolvers.shift();
            resolver?.(this.currentState);
          }
        }
      } catch {
        // ignore malformed lines
      }
    });

    this.process.on("exit", () => {
      this.process = null;
    });
  }

  private sendCommand(cmd: object) {
    if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(JSON.stringify(cmd) + "\n");
    }
  }

  async getState(): Promise<AudioState> {
    if (!this.process) {
      return { ...this.currentState };
    }
    return new Promise(resolve => {
      let settled = false;
      const wrappedResolve = (state: AudioState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.pendingResolvers.indexOf(wrappedResolve);
        if (idx !== -1) {
          this.pendingResolvers.splice(idx, 1);
        }
        resolve({ ...this.currentState });
      }, 250);
      this.pendingResolvers.push(wrappedResolve);
      this.sendCommand({ cmd: "get" });
    });
  }

  async setVolume(volume: VolumePercent): Promise<AudioState> {
    const clamped = clampVolume(volume);
    this.sendCommand({ cmd: "setVolume", volume: clamped });
    this.currentState.volume = clamped;
    return { ...this.currentState };
  }

  async adjustVolume(delta: number): Promise<AudioState> {
    const next = clampVolume(this.currentState.volume + delta);
    return this.setVolume(next);
  }

  async setMuted(muted: boolean): Promise<AudioState> {
    this.sendCommand({ cmd: "setMuted", muted });
    this.currentState.muted = muted;
    return { ...this.currentState };
  }

  async toggleMute(): Promise<AudioState> {
    return this.setMuted(!this.currentState.muted);
  }

  onStateChange(listener: AudioStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  private emit() {
    const copy = { ...this.currentState };
    for (const listener of this.listeners) {
      listener(copy);
    }
  }
}
