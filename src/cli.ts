#!/usr/bin/env node
import qrcode from "qrcode-terminal";
import path from "node:path";
import os from "node:os";
import { AppServer } from "./server/app-server.js";
import { CoreAudioDriver } from "./audio/core-audio-driver.js";
import { PairingAuthService } from "./auth/pairing-auth.js";
import { getLanInfo } from "./network/lan-info.js";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  restartLaunchAgent,
  getLaunchAgentStatus,
  readServiceLogs,
  rotateLogIfNeeded,
  getServicePaths,
  DEFAULT_SERVICE_LABEL
} from "./service/launchd.js";
import { resolvePackagePath } from "./shared/paths.js";
import { VolumeMemoryStore } from "./state/volume-memory-store.js";

const args = process.argv.slice(2);
const command = args[0] || "start";
const isDaemon = args.includes("--daemon");

function getPort(): number {
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    return parseInt(args[portIdx + 1], 10);
  }
  return parseInt(process.env.PORT || "4818", 10);
}

function getHostOverride(): string | undefined {
  const hostIdx = args.indexOf("--host");
  if (hostIdx !== -1 && args[hostIdx + 1]) {
    return args[hostIdx + 1];
  }
  return process.env.HOST;
}

const authService = new PairingAuthService();

async function showPairingInstructions(
  port: number,
  creds: { pin: string; bootstrapToken: string },
  overrideHost?: string
) {
  const lan = getLanInfo(port, creds.bootstrapToken, { overrideHost });
  console.log("\n========================================================");
  console.log("             MAC VOLUME REMOTE - PAIRING");
  console.log("========================================================\n");
  console.log(`  Target Interface: \x1b[36m${lan.selectedInterface}\x1b[0m (${lan.lanIp})`);

  if (lan.vpnInterfaces && lan.vpnInterfaces.length > 0) {
    console.log(`  \x1b[33mNotice: Active VPN/tunnel interface detected (${lan.vpnInterfaces.join(", ")}).\x1b[0m`);
    console.log("  QR code uses physical Wi-Fi IP so your iPhone can reach it.\n");
  }

  console.log("  Scan this QR code with your iPhone Camera to connect:\n");

  await new Promise<void>((resolve) => {
    qrcode.generate(lan.pairingUrl, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });

  console.log(`  Or open in Safari: ${lan.ipUrl} or ${lan.mDnsUrl}`);
  console.log(`  4-Digit PIN:       \x1b[1m\x1b[32m${creds.pin}\x1b[0m\n`);
  console.log("========================================================\n");
}

async function main() {
  const port = getPort();
  const overrideHost = getHostOverride();

  if (command === "start") {
    const creds = authService.getCredentials();
    const volumeMemoryStore = new VolumeMemoryStore();
    const rememberedState = volumeMemoryStore.load() ?? undefined;
    const bridgePath = resolvePackagePath("bin", "audio-bridge");
    const audioDriver = new CoreAudioDriver({ bridgePath, initialState: rememberedState });
    const lan = getLanInfo(port, creds.bootstrapToken, { overrideHost });

    if (isDaemon) {
      const { logPath } = getServicePaths();
      rotateLogIfNeeded(logPath);
    }

    const server = new AppServer({
      authService,
      audioDriver,
      volumeMemoryStore,
      hostName: lan.localHostName,
      port,
      publicDir: resolvePackagePath("public"),
      persistDebounceMs: isDaemon ? 250 : 0
    });

    const activePort = await server.start();

    if (isDaemon) {
      const now = new Date().toISOString();
      console.log(`[${now}] Mac Volume Remote daemon ready on http://0.0.0.0:${activePort} (LAN: ${lan.ipUrl})`);
    } else {
      await showPairingInstructions(activePort, creds, overrideHost);
      console.log(`[Mac Volume Remote] Server listening on http://0.0.0.0:${activePort}`);
      console.log("Press Ctrl+C to stop.");
    }

    let isShuttingDown = false;
    const handleShutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\nStopping server (${signal})...`);
      try {
        await server.stop();
        audioDriver.destroy();
      } catch (err: any) {
        console.error("Error during teardown:", err.message);
      }
      process.exit(0);
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));
  } else if (command === "pair") {
    let creds = authService.getCredentials();
    if (args.includes("--rotate")) {
      creds = authService.rotateCredentials();
      console.log("Rotated PIN and tokens successfully.");
    }
    await showPairingInstructions(port, creds, overrideHost);
  } else if (command === "service") {
    const sub = args[1];
    if (sub === "install") {
      const force = args.includes("--force");
      try {
        const plistPath = installLaunchAgent(port, { force });
        console.log(`\x1b[32m✔\x1b[0m Successfully installed launchd agent: ${plistPath}`);
        console.log("  • Auto-starts automatically on login / reboot / macOS update");
        console.log("  • Pinned to Apple Silicon Efficiency cores (low power)");
        console.log("  • Use 'volremote service status' to check state anytime.");
      } catch (err: any) {
        console.error(`\x1b[31m✖\x1b[0m Install failed: ${err.message}`);
        process.exit(1);
      }
    } else if (sub === "uninstall") {
      const ok = uninstallLaunchAgent();
      if (ok) {
        console.log("\x1b[32m✔\x1b[0m Successfully uninstalled launchd agent.");
      } else {
        console.log("No launchd agent found to uninstall.");
      }
    } else if (sub === "start") {
      try {
        startLaunchAgent();
        console.log("\x1b[32m✔\x1b[0m Started background service.");
      } catch (err: any) {
        console.error(`\x1b[31m✖\x1b[0m Start failed: ${err.message}`);
        process.exit(1);
      }
    } else if (sub === "stop") {
      try {
        stopLaunchAgent();
        console.log("\x1b[32m✔\x1b[0m Stopped background service (will stay stopped until started).");
      } catch (err: any) {
        console.error(`\x1b[31m✖\x1b[0m Stop failed: ${err.message}`);
        process.exit(1);
      }
    } else if (sub === "restart") {
      try {
        restartLaunchAgent();
        console.log("\x1b[32m✔\x1b[0m Restarted background service.");
      } catch (err: any) {
        console.error(`\x1b[31m✖\x1b[0m Restart failed: ${err.message}`);
        process.exit(1);
      }
    } else if (sub === "status") {
      const status = getLaunchAgentStatus(port);
      if (args.includes("--json")) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("\n========================================================");
        console.log("         MAC VOLUME REMOTE - SERVICE STATUS");
        console.log("========================================================\n");
        console.log(`  Service Label:  ${status.label}`);
        console.log(`  State:          ${status.state === "running" ? "\x1b[32m● Running\x1b[0m" : status.state === "not running" ? "\x1b[33m○ Stopped\x1b[0m" : "\x1b[31m○ " + status.state + "\x1b[0m"}`);
        console.log(`  Node PID:       ${status.pid ?? "None"}`);
        console.log(`  Bridge PID:     ${status.bridgePid ?? "None"}`);
        console.log(`  Port:           ${status.port}`);
        if (status.cpuPercent !== undefined) {
          console.log(`  Combined CPU:   ${status.cpuPercent}%`);
        }
        if (status.rssMb !== undefined) {
          console.log(`  Combined Memory:${status.rssMb} MB`);
        }
        console.log(`  Plist Path:     ${status.plistPath}`);
        console.log(`  Log Path:       ${status.logPath}\n`);
        console.log("========================================================\n");
      }
    } else if (sub === "logs") {
      const linesIdx = args.indexOf("--lines");
      const lines = linesIdx !== -1 && args[linesIdx + 1] ? parseInt(args[linesIdx + 1], 10) : 50;
      console.log(readServiceLogs(lines));
    } else {
      console.log("Usage: volremote service [install|uninstall|start|stop|restart|status|logs]");
      console.log("  volremote service install [--port 4818] [--force]  Install and enable LaunchAgent");
      console.log("  volremote service status [--json]                  View status and power footprint");
      console.log("  volremote service start                            Start background agent");
      console.log("  volremote service stop                             Stop background agent");
      console.log("  volremote service restart                          Restart background agent");
      console.log("  volremote service logs [--lines 50]                Tail recent logs");
      console.log("  volremote service uninstall                        Remove LaunchAgent completely");
    }
  } else {
    console.log("Usage: volremote [start|pair|service]");
    console.log("  volremote start [--port 4818] [--daemon] [--host <ip>] Start remote server");
    console.log("  volremote pair [--rotate] [--host <ip>]                Display QR code and PIN");
    console.log("  volremote service <command>                            Manage background LaunchAgent");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
