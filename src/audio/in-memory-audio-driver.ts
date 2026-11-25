import { AudioDriver, AudioStateListener } from "./audio-driver.js";
import { AudioState, VolumePercent, clampVolume } from "../shared/protocol.js";

export class InMemoryAudioDriver implements AudioDriver {
  private state: AudioState;
  private listeners: Set<AudioStateListener> = new Set();

  constructor(initialState?: Partial<AudioState>) {
    this.state = {
      volume: clampVolume(initialState?.volume ?? 50),
      muted: initialState?.muted ?? false,
      outputDevice: initialState?.outputDevice ?? "Mock Audio Device"
    };
  }

  async getState(): Promise<AudioState> {
    return { ...this.state };
  }

  async setVolume(volume: VolumePercent): Promise<AudioState> {
    this.state.volume = clampVolume(volume);
    this.emit();
    return { ...this.state };
  }

  async adjustVolume(delta: number): Promise<AudioState> {
    this.state.volume = clampVolume(this.state.volume + delta);
    this.emit();
    return { ...this.state };
  }

  async setMuted(muted: boolean): Promise<AudioState> {
    this.state.muted = muted;
    this.emit();
    return { ...this.state };
  }

  async toggleMute(): Promise<AudioState> {
    this.state.muted = !this.state.muted;
    this.emit();
    return { ...this.state };
  }

  onStateChange(listener: AudioStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
  }

  private emit() {
    const copy = { ...this.state };
    for (const listener of this.listeners) {
      listener(copy);
    }
  }
}
