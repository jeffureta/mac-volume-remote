import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AudioState, clampVolume } from "../shared/protocol.js";

export interface PersistedVolumeState extends AudioState {
  updatedAt: string;
}

/**
 * Atomic on-disk persistence for the latest macOS AudioState so volume levels
 * survive server restarts and remain synchronized across iPhones.
 */
export class VolumeMemoryStore {
  private readonly filePath: string;
  private pendingState: AudioState | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(customPath?: string) {
    this.filePath =
      customPath ?? path.join(os.homedir(), ".config", "mac-volume-remote", "volume-state.json");
  }

  public getPath(): string {
    return this.filePath;
  }

  public hasPendingWrite(): boolean {
    return this.pendingState !== null;
  }

  public load(): PersistedVolumeState | null {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.volume !== "number" ||
        !Number.isFinite(parsed.volume) ||
        typeof parsed.muted !== "boolean" ||
        typeof parsed.outputDevice !== "string"
      ) {
        return null;
      }

      return {
        volume: clampVolume(parsed.volume),
        muted: parsed.muted,
        outputDevice: parsed.outputDevice,
        updatedAt:
          typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))
            ? parsed.updatedAt
            : new Date().toISOString()
      };
    } catch {
      return null;
    }
  }

  public save(state: AudioState): PersistedVolumeState {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingState = null;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const persisted: PersistedVolumeState = {
      volume: clampVolume(state.volume),
      muted: Boolean(state.muted),
      outputDevice: String(state.outputDevice || "macOS Audio"),
      updatedAt: new Date().toISOString()
    };

    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(persisted, null, 2), {
      encoding: "utf-8",
      mode: 0o600
    });
    fs.renameSync(tempPath, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {}
    return persisted;
  }

  public scheduleSave(state: AudioState, delayMs: number = 250): PersistedVolumeState {
    this.pendingState = { ...state };
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const unrefTimer = setTimeout(() => {
      this.flush();
    }, delayMs);

    if (typeof unrefTimer.unref === "function") {
      unrefTimer.unref();
    }
    this.debounceTimer = unrefTimer;

    return {
      volume: clampVolume(state.volume),
      muted: Boolean(state.muted),
      outputDevice: String(state.outputDevice || "macOS Audio"),
      updatedAt: new Date().toISOString()
    };
  }

  public flush(): PersistedVolumeState | null {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.pendingState) {
      return null;
    }
    const target = this.pendingState;
    this.pendingState = null;
    return this.save(target);
  }
}
