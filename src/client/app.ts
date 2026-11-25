import { RemoteController } from "./remote-controller.js";
import { ClientCommand, AudioState } from "../shared/protocol.js";
import {
  DiagnosticsStore,
  copyTextToClipboard,
  DiagnosticErrorCode,
  redactSensitiveUrl
} from "./diagnostics.js";

const TOKEN_KEY = "mac_volume_remote_token";

class AppView {
  private ws: WebSocket | null = null;
  private controller: RemoteController;
  private token: string | null = null;
  private diagnostics = new DiagnosticsStore(15);
  private wsConnectTimeoutTimer?: any;
  private wsStatusStr = "DISCONNECTED";

  // DOM elements
  private pillar = document.getElementById("pillar") as HTMLDivElement;
  private pillarFill = document.getElementById("pillarFill") as HTMLDivElement;
  private volumeText = document.getElementById("volumeText") as HTMLDivElement;
  private statusDot = document.getElementById("statusDot") as HTMLDivElement;
  private statusPill = document.getElementById("statusPill") as HTMLButtonElement;
  private hostLabel = document.getElementById("hostLabel") as HTMLSpanElement;
  private deviceBadge = document.getElementById("deviceBadge") as HTMLDivElement;
  private muteBtn = document.getElementById("muteBtn") as HTMLButtonElement;

  // Error Banner
  private errorBanner = document.getElementById("errorBanner") as HTMLDivElement;
  private errorBannerTitle = document.getElementById("errorBannerTitle") as HTMLDivElement;
  private errorBannerMsg = document.getElementById("errorBannerMsg") as HTMLDivElement;
  private errorCopyBtn = document.getElementById("errorCopyBtn") as HTMLButtonElement;
  private errorDetailsBtn = document.getElementById("errorDetailsBtn") as HTMLButtonElement;
  private errorDismissBtn = document.getElementById("errorDismissBtn") as HTMLButtonElement;

  // Pairing Modal
  private pairingModal = document.getElementById("pairingModal") as HTMLDivElement;
  private pairingInlineError = document.getElementById("pairingInlineError") as HTMLDivElement;
  private pinDigits = Array.from(document.querySelectorAll<HTMLInputElement>(".pin-digit"));
  private submitPinBtn = document.getElementById("submitPinBtn") as HTMLButtonElement;
  private pairingHelpBtn = document.getElementById("pairingHelpBtn") as HTMLButtonElement;

  // Diagnostics Modal
  private diagnosticsModal = document.getElementById("diagnosticsModal") as HTMLDivElement;
  private diagnosticsOutput = document.getElementById("diagnosticsOutput") as HTMLTextAreaElement;
  private copyDiagnosticsBtn = document.getElementById("copyDiagnosticsBtn") as HTMLButtonElement;
  private probeHealthBtn = document.getElementById("probeHealthBtn") as HTMLButtonElement;
  private resetPairingBtn = document.getElementById("resetPairingBtn") as HTMLButtonElement;
  private closeDiagnosticsBtn = document.getElementById("closeDiagnosticsBtn") as HTMLButtonElement;

  constructor() {
    (window as any).__MVR_BOOTED__ = true;
    this.diagnostics.recordEvent("boot", "Application mounted successfully");

    // Ingest any early window errors caught before this class initialized
    const early = (window as any).__MVR_EARLY_ERRORS__ || [];
    for (const item of early) {
      this.diagnostics.recordEvent("pre-boot-warn", item.message || String(item.reason || item));
    }

    this.controller = new RemoteController({
      sendCommand: (cmd: ClientCommand) => this.sendWs(cmd),
      onUIUpdate: (state: AudioState) => this.render(state)
    });

    this.bindEvents();
    this.initAuth();
  }

  private showErrorBanner(code: DiagnosticErrorCode, message: string, details?: string) {
    this.diagnostics.setError({ code, message, details });
    this.errorBannerTitle.textContent = code;
    this.errorBannerMsg.textContent = message;
    this.errorBanner.style.display = "flex";
  }

  private hideErrorBanner() {
    this.errorBanner.style.display = "none";
  }

  private async probeServer(): Promise<{ healthOk: boolean; healthSummary: string; authValid: boolean }> {
    let healthOk = false;
    let healthSummary = "Unreachable";
    let authValid = false;

    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        healthOk = true;
        const data = await res.json();
        healthSummary = `200 OK (host=${data.hostName}, uptime=${data.uptimeSec}s, assetsReady=${data.assetsReady})`;
      } else {
        healthSummary = `HTTP ${res.status}`;
      }
    } catch (e: any) {
      healthSummary = `Failed to fetch /api/health (${e.message || "Network Error"})`;
    }

    if (this.token) {
      try {
        const authRes = await fetch("/api/auth/verify", {
          headers: { Authorization: `Bearer ${this.token}` },
          cache: "no-store"
        });
        authValid = authRes.status === 200;
      } catch {
        authValid = false;
      }
    }

    return { healthOk, healthSummary, authValid };
  }

  private async openDiagnosticsSheet() {
    const probe = await this.probeServer();
    const report = this.diagnostics.formatReport({
      currentUrl: window.location.href,
      wsState: this.wsStatusStr,
      healthSummary: probe.healthSummary,
      userAgent: navigator.userAgent
    });
    this.diagnosticsOutput.value = report;
    this.diagnosticsModal.style.display = "flex";
  }

  private async initAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const bootstrapToken = urlParams.get("pair");

    if (bootstrapToken) {
      this.diagnostics.recordEvent("auth", `Exchanging bootstrap token ?pair=${bootstrapToken.substring(0, 4)}...`);
      try {
        const res = await fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bootstrapToken })
        });

        if (res.ok) {
          const data = await res.json();
          this.token = data.token;
          this.safeSetStorage(TOKEN_KEY, data.token);
          this.diagnostics.recordEvent("auth", "Bootstrap token exchange successful");
          window.history.replaceState({}, document.title, window.location.pathname);
          this.connectWs();
          return;
        }

        const errData = await res.json().catch(() => ({}));
        const code = (errData.code as DiagnosticErrorCode) || "E_PAIR_FAILED";
        const msg = errData.error || "Failed to pair using QR code.";
        this.showErrorBanner(code, msg);
      } catch (err: any) {
        this.showErrorBanner("E_SERVER_UNREACHABLE", "Cannot reach Mac server. Verify iPhone is on same Wi-Fi.", err.message);
      }
    }

    this.token = this.safeGetStorage(TOKEN_KEY);
    if (!this.token) {
      this.showPairingModal();
    } else {
      this.connectWs();
    }
  }

  private connectWs() {
    if (!this.token) return;

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${this.token}`;
    this.wsStatusStr = "CONNECTING";
    this.diagnostics.recordEvent("ws", `Connecting to ${wsUrl}`);

    clearTimeout(this.wsConnectTimeoutTimer);
    this.wsConnectTimeoutTimer = setTimeout(async () => {
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.wsStatusStr = "TIMEOUT";
        this.diagnostics.recordEvent("ws", "Connection watchdog timed out (5s)");
        const probe = await this.probeServer();
        if (!probe.healthOk) {
          this.showErrorBanner("E_SERVER_UNREACHABLE", "Server connection timed out. Mac may be asleep or Wi-Fi blocked.");
        } else if (!probe.authValid) {
          this.handleAuthRevocation();
        } else {
          this.showErrorBanner("E_WS_TIMEOUT", "WebSocket connection timed out.");
        }
      }
    }, 5000);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err: any) {
      this.showErrorBanner("E_RUNTIME_ERROR", "Failed to construct WebSocket.", err.message);
      return;
    }

    this.ws.onopen = () => {
      clearTimeout(this.wsConnectTimeoutTimer);
      this.wsStatusStr = "OPEN";
      this.statusDot.classList.add("connected");
      this.hideErrorBanner();
      this.diagnostics.recordEvent("ws", "WebSocket connected cleanly");
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
        // ignore malformed
      }
    };

    this.ws.onclose = async (event) => {
      clearTimeout(this.wsConnectTimeoutTimer);
      this.wsStatusStr = `CLOSED (${event.code})`;
      this.statusDot.classList.remove("connected");
      this.hostLabel.textContent = "Disconnected";
      this.diagnostics.recordEvent("ws", `WebSocket closed (code=${event.code}, wasClean=${event.wasClean})`);

      // Probe health and auth to classify root cause accurately
      const probe = await this.probeServer();
      if (!probe.healthOk) {
        this.showErrorBanner("E_SERVER_UNREACHABLE", "Cannot communicate with Mac. Check Wi-Fi connection.", probe.healthSummary);
        setTimeout(() => this.connectWs(), 3000);
      } else if (!probe.authValid) {
        this.handleAuthRevocation();
      } else {
        setTimeout(() => this.connectWs(), 2000);
      }
    };

    this.ws.onerror = (e) => {
      this.diagnostics.recordEvent("ws-err", "WebSocket error event triggered");
    };
  }

  private handleAuthRevocation() {
    this.safeRemoveStorage(TOKEN_KEY);
    this.token = null;
    this.showErrorBanner("E_AUTH_EXPIRED", "Session expired or revoked. Please enter the 4-digit PIN.");
    this.showPairingModal("Session expired. Please enter the PIN from your Mac terminal.");
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
    // Status pill opens diagnostics
    this.statusPill.addEventListener("click", () => this.openDiagnosticsSheet());
    this.pairingHelpBtn.addEventListener("click", () => this.openDiagnosticsSheet());
    this.closeDiagnosticsBtn.addEventListener("click", () => {
      this.diagnosticsModal.style.display = "none";
    });

    // Error banner actions
    this.errorDismissBtn.addEventListener("click", () => this.hideErrorBanner());
    this.errorDetailsBtn.addEventListener("click", () => this.openDiagnosticsSheet());
    this.errorCopyBtn.addEventListener("click", async () => {
      const report = this.diagnostics.formatReport({
        currentUrl: window.location.href,
        wsState: this.wsStatusStr,
        userAgent: navigator.userAgent
      });
      await copyTextToClipboard(report);
      this.errorCopyBtn.textContent = "Copied!";
      setTimeout(() => { this.errorCopyBtn.textContent = "Copy"; }, 2000);
    });

    // Diagnostics modal actions
    this.copyDiagnosticsBtn.addEventListener("click", async () => {
      await copyTextToClipboard(this.diagnosticsOutput.value);
      this.copyDiagnosticsBtn.textContent = "Copied!";
      setTimeout(() => { this.copyDiagnosticsBtn.textContent = "Copy Report"; }, 2000);
    });

    this.probeHealthBtn.addEventListener("click", async () => {
      this.probeHealthBtn.textContent = "Checking...";
      await this.openDiagnosticsSheet();
      this.probeHealthBtn.textContent = "Check Health";
    });

    this.resetPairingBtn.addEventListener("click", () => {
      this.safeRemoveStorage(TOKEN_KEY);
      this.token = null;
      this.diagnosticsModal.style.display = "none";
      this.showPairingModal("Saved credentials cleared. Enter PIN to reconnect.");
    });

    // Visibility change auto-reconnect
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.diagnostics.recordEvent("lifecycle", "Page became visible (wake)");
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.connectWs();
        }
      }
    });

    // Pointer drag on pillar
    this.pillar.addEventListener("pointerdown", (e) => {
      this.pillar.setPointerCapture(e.pointerId);
      const rect = this.pillar.getBoundingClientRect();
      const vol = this.controller.calculateVolumeFromPointerY(e.clientY, rect);
      this.controller.startDrag(vol);
    });

    this.pillar.addEventListener("pointermove", (e) => {
      if (this.pillar.hasPointerCapture(e.pointerId)) {
        const rect = this.pillar.getBoundingClientRect();
        const vol = this.controller.calculateVolumeFromPointerY(e.clientY, rect);
        this.controller.updateDragVolume(vol);
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

      this.pairingInlineError.style.display = "none";
      this.submitPinBtn.textContent = "Connecting...";

      try {
        const res = await fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin })
        });

        if (res.ok) {
          const data = await res.json();
          this.token = data.token;
          this.safeSetStorage(TOKEN_KEY, data.token);
          this.pairingModal.style.display = "none";
          this.submitPinBtn.textContent = "Connect";
          this.connectWs();
        } else {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.error || "Incorrect 4-digit PIN. Check terminal.";
          this.pairingInlineError.textContent = errMsg;
          this.pairingInlineError.style.display = "block";
          this.submitPinBtn.textContent = "Connect";
          this.showErrorBanner(errData.code || "E_PAIR_FAILED", errMsg);
        }
      } catch (err: any) {
        this.pairingInlineError.textContent = "Connection error. Is Mac on same Wi-Fi?";
        this.pairingInlineError.style.display = "block";
        this.submitPinBtn.textContent = "Connect";
        this.showErrorBanner("E_SERVER_UNREACHABLE", "Cannot reach Mac server.", err.message);
      }
    });
  }

  private showPairingModal(errorNotice?: string) {
    if (errorNotice) {
      this.pairingInlineError.textContent = errorNotice;
      this.pairingInlineError.style.display = "block";
    } else {
      this.pairingInlineError.style.display = "none";
    }
    this.pairingModal.style.display = "flex";
    this.pinDigits[0].focus();
  }

  private safeGetStorage(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      this.diagnostics.recordEvent("storage", "localStorage.getItem blocked");
      return null;
    }
  }

  private safeSetStorage(key: string, val: string) {
    try {
      localStorage.setItem(key, val);
    } catch {
      this.diagnostics.recordEvent("storage", "localStorage.setItem blocked");
    }
  }

  private safeRemoveStorage(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      this.diagnostics.recordEvent("storage", "localStorage.removeItem blocked");
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new AppView();
});
