export type DiagnosticErrorCode =
  | "E_BOOT_FAILED"
  | "E_RUNTIME_ERROR"
  | "E_PAIR_FAILED"
  | "E_PAIR_RATE_LIMITED"
  | "E_AUTH_EXPIRED"
  | "E_SERVER_UNREACHABLE"
  | "E_WS_TIMEOUT"
  | "E_WS_DISCONNECTED"
  | "E_STORAGE_BLOCKED";

export interface DiagnosticError {
  code: DiagnosticErrorCode;
  message: string;
  details?: string;
  stack?: string;
  timestamp?: string;
}

export interface DiagnosticEvent {
  timestamp: string;
  category: string;
  message: string;
}

export interface ReportEnvironment {
  currentUrl?: string;
  wsState?: string;
  healthSummary?: string;
  userAgent?: string;
}

export function redactSensitiveUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  return rawUrl
    .replace(/([?&]pair=)[^&#\s]+/g, "$1[REDACTED]")
    .replace(/([?&]token=)[^&#\s]+/g, "$1[REDACTED]");
}

export class DiagnosticsStore {
  private maxEvents: number;
  private events: DiagnosticEvent[] = [];
  private activeError: DiagnosticError | null = null;

  constructor(maxEvents: number = 15) {
    this.maxEvents = maxEvents;
  }

  public recordEvent(category: string, message: string) {
    const safeMessage = redactSensitiveUrl(message);
    const item: DiagnosticEvent = {
      timestamp: new Date().toISOString(),
      category,
      message: safeMessage
    };
    this.events.push(item);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  public setError(err: DiagnosticError) {
    this.activeError = {
      ...err,
      message: redactSensitiveUrl(err.message),
      details: err.details ? redactSensitiveUrl(err.details) : undefined,
      timestamp: err.timestamp || new Date().toISOString()
    };
    this.recordEvent("error", `${err.code}: ${err.message}`);
  }

  public getActiveError(): DiagnosticError | null {
    return this.activeError;
  }

  public clearError() {
    this.activeError = null;
  }

  public getRecentEvents(): DiagnosticEvent[] {
    return [...this.events];
  }

  public formatReport(env: ReportEnvironment = {}): string {
    const err = this.activeError;
    const timestamp = err?.timestamp || new Date().toISOString();
    const redactedUrl = env.currentUrl ? redactSensitiveUrl(env.currentUrl) : "N/A";

    const lines: string[] = [
      "=== Mac Volume Remote — Error Report ===",
      `Code:       ${err?.code || "INFO_OK"}`,
      `Message:    ${err?.message || "No active error."}`,
      `Timestamp:  ${timestamp}`,
      `Page URL:   ${redactedUrl}`,
      `WS State:   ${env.wsState || "N/A"}`,
      `Health:     ${env.healthSummary || "Not probed"}`,
      `User-Agent: ${env.userAgent || (typeof navigator !== "undefined" ? navigator.userAgent : "N/A")}`
    ];

    if (err?.details) {
      lines.push(`Details:    ${err.details}`);
    }

    if (err?.stack) {
      lines.push("\nStack Trace:");
      lines.push(err.stack);
    }

    lines.push("\nRecent Events:");
    if (this.events.length === 0) {
      lines.push("- (no events recorded)");
    } else {
      for (const ev of this.events) {
        const timePart = ev.timestamp.substring(11, 23);
        lines.push(`- ${timePart} [${ev.category}] ${ev.message}`);
      }
    }

    return lines.join("\n");
  }
}

export interface CopyDeps {
  clipboard?: { writeText(text: string): Promise<void> };
  document?: {
    createElement(tag: string): any;
    body: { appendChild(el: any): void; removeChild(el: any): void };
    execCommand(command: string): boolean;
  };
}

export async function copyTextToClipboard(
  text: string,
  deps: CopyDeps = {}
): Promise<"clipboard" | "execCommand" | "manual"> {
  const clipboardObj = deps.clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

  if (clipboardObj && typeof clipboardObj.writeText === "function") {
    try {
      await clipboardObj.writeText(text);
      return "clipboard";
    } catch {
      // Fall through to execCommand
    }
  }

  const doc = deps.document ?? (typeof document !== "undefined" ? document : undefined);
  if (doc && typeof doc.createElement === "function" && typeof doc.execCommand === "function") {
    try {
      const textarea = doc.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";

      doc.body.appendChild(textarea);
      if (typeof textarea.select === "function") {
        textarea.select();
      }
      if (typeof textarea.setSelectionRange === "function") {
        textarea.setSelectionRange(0, text.length);
      }

      const success = doc.execCommand("copy");
      doc.body.removeChild(textarea);
      if (success) {
        return "execCommand";
      }
    } catch {
      // Fall through to manual
    }
  }

  return "manual";
}
