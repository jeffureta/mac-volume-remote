import { AudioState, ClientCommand, VolumePercent, clampVolume } from "../shared/protocol.js";

export interface BoundingBox {
  top: number;
  bottom: number;
  height: number;
}

export interface RemoteControllerOptions {
  sendCommand: (cmd: ClientCommand) => void;
  onUIUpdate?: (state: AudioState, isDragging: boolean) => void;
}

export class RemoteController {
  private sendCommand: (cmd: ClientCommand) => void;
  private onUIUpdate?: (state: AudioState, isDragging: boolean) => void;
  
  private authoritativeState: AudioState = {
    volume: 50,
    muted: false,
    outputDevice: "Default Output"
  };
  
  private dragVolume: VolumePercent = 50;
  private isDragging: boolean = false;

  constructor(options: RemoteControllerOptions) {
    this.sendCommand = options.sendCommand;
    this.onUIUpdate = options.onUIUpdate;
  }

  public calculateVolumeFromPointerY(clientY: number, rect: BoundingBox): VolumePercent {
    if (rect.height <= 0) return 0;
    const clampedY = Math.max(rect.top, Math.min(rect.bottom, clientY));
    const ratio = (rect.bottom - clampedY) / rect.height;
    return clampVolume(ratio * 100);
  }

  public applyServerState(state: AudioState) {
    this.authoritativeState = { ...state };
    if (!this.isDragging) {
      this.dragVolume = state.volume;
      this.notifyUI();
    }
  }

  public getCurrentDisplayVolume(): VolumePercent {
    return this.isDragging ? this.dragVolume : this.authoritativeState.volume;
  }

  public isMuted(): boolean {
    return this.authoritativeState.muted;
  }

  public getOutputDevice(): string {
    return this.authoritativeState.outputDevice;
  }

  public startDrag(initialVolume: VolumePercent) {
    this.isDragging = true;
    this.updateDragVolume(initialVolume);
  }

  public updateDragVolume(volume: VolumePercent) {
    this.dragVolume = clampVolume(volume);
    this.sendCommand({ type: "setVolume", volume: this.dragVolume });
    this.notifyUI();
  }

  public endDrag() {
    this.isDragging = false;
    this.notifyUI();
  }

  public stepVolume(delta: number) {
    this.sendCommand({ type: "adjustVolume", delta });
  }

  public setPreset(volume: VolumePercent) {
    const clamped = clampVolume(volume);
    this.sendCommand({ type: "setVolume", volume: clamped });
  }

  public toggleMute() {
    this.sendCommand({ type: "toggleMute" });
  }

  private notifyUI() {
    if (this.onUIUpdate) {
      const displayState: AudioState = {
        volume: this.getCurrentDisplayVolume(),
        muted: this.authoritativeState.muted,
        outputDevice: this.authoritativeState.outputDevice
      };
      this.onUIUpdate(displayState, this.isDragging);
    }
  }
}
