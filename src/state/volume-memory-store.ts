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

  constructor(customPath?: string) {
    this.filePath =
      customPath ?? path.join(os.homedir(), ".config", "mac-volume-remote", "volume-state.json");
  }

  public getPath(): string {
    return this.filePath;
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
    fs.chmodSync(this.filePath, 0o600);
    return persisted;
  }
}
