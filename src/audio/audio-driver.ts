import { AudioState, VolumePercent } from "../shared/protocol.js";

export type AudioStateListener = (state: AudioState) => void;

export interface AudioDriver {
  getState(): Promise<AudioState>;
  setVolume(volume: VolumePercent): Promise<AudioState>;
  adjustVolume(delta: number): Promise<AudioState>;
  setMuted(muted: boolean): Promise<AudioState>;
  toggleMute(): Promise<AudioState>;
  onStateChange(listener: AudioStateListener): () => void;
  destroy(): void;
}
