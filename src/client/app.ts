import { RemoteController } from "./remote-controller.js";
import { ClientCommand, AudioState } from "../shared/protocol.js";

const TOKEN_KEY = "mac_volume_remote_token";

class AppView {
  private ws: WebSocket | null = null;
  private controller: RemoteController;
  private token: string | null = null;

  private pillar = document.getElementById("pillar") as HTMLDivElement;
  private pillarFill = document.getElementById("pillarFill") as HTMLDivElement;
  private volumeText = document.getElementById("volumeText") as HTMLDivElement;
  private statusDot = document.getElementById("statusDot") as HTMLDivElement;
  private hostLabel = document.getElementById("hostLabel") as HTMLSpanElement;
  private deviceBadge = document.getElementById("deviceBadge") as HTMLDivElement;
  private muteBtn = document.getElementById("muteBtn") as HTMLButtonElement;
  private pairingModal = document.getElementById("pairingModal") as HTMLDivElement;
  private pinDigits = Array.from(document.querySelectorAll<HTMLInputElement>(".pin-digit"));
  private submitPinBtn = document.getElementById("submitPinBtn") as HTMLButtonElement;

  constructor() {
    this.controller = new RemoteController({
      sendCommand: (cmd: ClientCommand) => this.sendWs(cmd),
      onUIUpdate: (state: AudioState) => this.render(state)
    });

    this.bindEvents();
    this.initAuth();
  }

  private async initAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const bootstrapToken = urlParams.get("pair");

    if (bootstrapToken) {
      try {
        const res = await fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bootstrapToken })
        });
        if (res.ok) {
          const data = await res.json();
          this.token = data.token;
          localStorage.setItem(TOKEN_KEY, data.token);
          window.history.replaceState({}, document.title, window.location.pathname);
          this.connectWs();
          return;
        }
      } catch {
        // fallback to manual pin
      }
    }

    this.token = localStorage.getItem(TOKEN_KEY);
    if (!this.token) {
      this.showPairingModal();
    } else {
      this.connectWs();
    }
  }

  private connectWs() {
    if (!this.token) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${this.token}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.statusDot.classList.add("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "state") {
          this.hostLabel.textContent = msg.hostName || "Mac Remote";
          this.deviceBadge.textContent = msg.state.outputDevice || "Speakers";
          this.controller.applyServerState(msg.state);
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = (event) => {
      this.statusDot.classList.remove("connected");
      this.hostLabel.textContent = "Disconnected";
      if (event.code === 4001) {
        localStorage.removeItem(TOKEN_KEY);
        this.token = null;
        this.showPairingModal();
      } else {
        setTimeout(() => this.connectWs(), 2000);
      }
    };
  }

  private sendWs(cmd: ClientCommand) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  private render(state: AudioState) {
    this.volumeText.textContent = `${state.volume}%`;
    this.pillarFill.style.height = `${state.volume}%`;

    if (state.muted) {
      this.pillar.classList.add("muted");
      this.muteBtn.classList.add("active");
      this.muteBtn.textContent = "Unmute";
    } else {
      this.pillar.classList.remove("muted");
      this.muteBtn.classList.remove("active");
      this.muteBtn.textContent = "Mute";
    }
  }

  private bindEvents() {
    // Pointer drag on pillar
    const handlePointer = (e: PointerEvent) => {
      const rect = this.pillar.getBoundingClientRect();
      const vol = this.controller.calculateVolumeFromPointerY(e.clientY, rect);
      this.controller.updateDragVolume(vol);
    };

    this.pillar.addEventListener("pointerdown", (e) => {
      this.pillar.setPointerCapture(e.pointerId);
      const rect = this.pillar.getBoundingClientRect();
      const vol = this.controller.calculateVolumeFromPointerY(e.clientY, rect);
      this.controller.startDrag(vol);
    });

    this.pillar.addEventListener("pointermove", (e) => {
      if (this.pillar.hasPointerCapture(e.pointerId)) {
        handlePointer(e);
      }
    });

    const releasePointer = (e: PointerEvent) => {
      if (this.pillar.hasPointerCapture(e.pointerId)) {
        this.pillar.releasePointerCapture(e.pointerId);
        this.controller.endDrag();
      }
    };

    this.pillar.addEventListener("pointerup", releasePointer);
    this.pillar.addEventListener("pointercancel", releasePointer);

    // Controls
    document.getElementById("stepDown5")?.addEventListener("click", () => this.controller.stepVolume(-5));
    document.getElementById("stepDown1")?.addEventListener("click", () => this.controller.stepVolume(-1));
    document.getElementById("stepUp1")?.addEventListener("click", () => this.controller.stepVolume(1));
    document.getElementById("stepUp5")?.addEventListener("click", () => this.controller.stepVolume(5));

    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const vol = parseInt(btn.getAttribute("data-vol") || "50", 10);
        this.controller.setPreset(vol);
      });
    });

    this.muteBtn.addEventListener("click", () => this.controller.toggleMute());

    // PIN inputs
    this.pinDigits.forEach((input, index) => {
      input.addEventListener("input", () => {
        if (input.value && index < this.pinDigits.length - 1) {
          this.pinDigits[index + 1].focus();
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !input.value && index > 0) {
          this.pinDigits[index - 1].focus();
        }
      });
    });

    this.submitPinBtn.addEventListener("click", async () => {
      const pin = this.pinDigits.map(d => d.value).join("");
      if (pin.length !== 4) return;

      try {
        const res = await fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin })
        });
        if (res.ok) {
          const data = await res.json();
          this.token = data.token;
          localStorage.setItem(TOKEN_KEY, data.token);
          this.pairingModal.style.display = "none";
          this.connectWs();
        } else {
          alert("Invalid PIN. Check terminal.");
        }
      } catch {
        alert("Connection error.");
      }
    });
  }

  private showPairingModal() {
    this.pairingModal.style.display = "flex";
    this.pinDigits[0].focus();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new AppView();
});
