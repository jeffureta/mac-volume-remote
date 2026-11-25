import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { AudioDriver, AudioStateListener } from "./audio-driver.js";
import { AudioState, VolumePercent, clampVolume } from "../shared/protocol.js";

export interface CoreAudioDriverOptions {
  bridgePath?: string;
  initialState?: Partial<AudioState>;
  autoRestart?: boolean;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  maxRestartAttempts?: number;
  onBridgeEvent?: (message: string) => void;
}

export class CoreAudioDriver implements AudioDriver {
  private bridgePath: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private currentState: AudioState;
  private listeners: Set<AudioStateListener> = new Set();
  private pendingResolvers: Array<(state: AudioState) => void> = [];
  
  private autoRestart: boolean;
  private restartBaseDelayMs: number;
  private restartMaxDelayMs: number;
  private maxRestartAttempts: number;
  private onBridgeEvent?: (message: string) => void;
  
  private restartAttempts: number = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private destroyed: boolean = false;

  constructor(options: CoreAudioDriverOptions = {}) {
    this.bridgePath = options.bridgePath ?? path.resolve("bin/audio-bridge");
    this.currentState = {
      volume: clampVolume(options.initialState?.volume ?? 50),
      muted: Boolean(options.initialState?.muted ?? false),
      outputDevice: String(options.initialState?.outputDevice || "macOS Audio")
    };
    this.autoRestart = options.autoRestart ?? true;
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 250;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 10_000;
    this.maxRestartAttempts = options.maxRestartAttempts ?? 10;
    this.onBridgeEvent = options.onBridgeEvent;

    this.spawnBridge();
  }

  private logEvent(message: string) {
    this.onBridgeEvent?.(message);
  }

  private spawnBridge() {
    if (this.destroyed) return;
    if (!fs.existsSync(this.bridgePath)) {
      this.logEvent(`Bridge binary not found at ${this.bridgePath}`);
      return;
    }

    try {
      this.process = spawn(this.bridgePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      this.logEvent(`Failed to spawn bridge: ${err.message}`);
      this.scheduleRestart();
      return;
    }

    this.rl = readline.createInterface({
      input: this.process.stdout,
      terminal: false
    });

    this.rl.on("line", (line: string) => {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.type === "state") {
          if (this.restartAttempts > 0) {
            this.logEvent("Bridge respawned successfully and synchronized state.");
            this.restartAttempts = 0;
          }
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

    this.process.on("exit", (code, signal) => {
      this.cleanupChild();
      if (!this.destroyed) {
        this.logEvent(`Bridge exited unexpectedly (code=${code}, signal=${signal}).`);
        this.flushPendingResolvers();
        if (this.autoRestart) {
          this.scheduleRestart();
        }
      }
    });
  }

  private cleanupChild() {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    this.process = null;
  }

  private scheduleRestart() {
    if (this.destroyed || this.restartTimer) return;
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.logEvent(`Max restart attempts (${this.maxRestartAttempts}) reached for bridge.`);
      return;
    }

    const delay = Math.min(
      this.restartBaseDelayMs * Math.pow(2, this.restartAttempts),
      this.restartMaxDelayMs
    );
    this.restartAttempts++;
    this.logEvent(`Scheduling bridge restart attempt ${this.restartAttempts} in ${delay}ms`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.destroyed) {
        this.spawnBridge();
      }
    }, delay);
  }

  private flushPendingResolvers() {
    while (this.pendingResolvers.length > 0) {
      const resolver = this.pendingResolvers.shift();
      resolver?.({ ...this.currentState });
    }
  }

  private sendCommand(cmd: object) {
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write(JSON.stringify(cmd) + "\n");
      } catch {
        // Child pipe broken
      }
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
    this.destroyed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.listeners.clear();
    this.flushPendingResolvers();
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {}
      this.cleanupChild();
    }
  }

  private emit() {
    const copy = { ...this.currentState };
    for (const listener of this.listeners) {
      listener(copy);
    }
  }
}
