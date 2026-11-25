import { describe, it, expect } from "vitest";
import {
  redactSensitiveUrl,
  DiagnosticsStore,
  copyTextToClipboard
} from "../src/client/diagnostics.js";

describe("Client Diagnostics & Copy Engine", () => {
  it("redacts sensitive pair and token parameters from HTTP and WS URLs", () => {
    expect(redactSensitiveUrl("http://192.168.0.109:4818/?pair=abcdef1234567890")).toBe(
      "http://192.168.0.109:4818/?pair=[REDACTED]"
    );
    expect(redactSensitiveUrl("ws://192.168.0.109:4818/ws?token=my-secret-token&foo=bar")).toBe(
      "ws://192.168.0.109:4818/ws?token=[REDACTED]&foo=bar"
    );
    expect(redactSensitiveUrl("plain string without url")).toBe("plain string without url");
  });

  it("DiagnosticsStore maintains a ring buffer of events and formats plain-text report", () => {
    const store = new DiagnosticsStore(5);
    store.recordEvent("boot", "App initialized");
    store.recordEvent("ws", "Connecting to ws://192.168.0.109:4818/ws?token=secret123");
    store.setError({
      code: "E_AUTH_EXPIRED",
      message: "Session token expired or revoked.",
      stack: "Error: Session expired\n    at AppView.connectWs"
    });

    const report = store.formatReport({
      currentUrl: "http://192.168.0.109:4818/?pair=secretBootstrap",
      wsState: "CLOSED (1006)",
      healthSummary: "200 OK (host=Jeffs-MacBook-Air, assetsReady=true)",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
    });

    expect(report).toContain("=== Mac Volume Remote — Error Report ===");
    expect(report).toContain("Code:       E_AUTH_EXPIRED");
    expect(report).toContain("pair=[REDACTED]");
    expect(report).toContain("token=[REDACTED]");
    expect(report).toContain("Health:     200 OK");
  });

  it("copyTextToClipboard falls back from navigator.clipboard to textarea execCommand", async () => {
    // Test clipboard API success
    let writtenText = "";
    const mockClipboard = {
      writeText: async (txt: string) => { writtenText = txt; }
    };
    const res1 = await copyTextToClipboard("Hello remote", { clipboard: mockClipboard as any });
    expect(res1).toBe("clipboard");
    expect(writtenText).toBe("Hello remote");

    // Test fallback execCommand when clipboard fails or unavailable (common on HTTP in iOS Safari)
    let execCmdCalled = "";
    const mockDoc = {
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {}
      }),
      body: {
        appendChild: () => {},
        removeChild: () => {}
      },
      execCommand: (cmd: string) => {
        execCmdCalled = cmd;
        return true;
      }
    };
    const res2 = await copyTextToClipboard("Fallback text", {
      clipboard: undefined,
      document: mockDoc as any
    });
    expect(res2).toBe("execCommand");
    expect(execCmdCalled).toBe("copy");
  });
});
