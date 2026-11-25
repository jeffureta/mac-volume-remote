#!/usr/bin/env node
import qrcode from "qrcode-terminal";
import path from "node:path";
import { AppServer } from "./server/app-server.js";
import { CoreAudioDriver } from "./audio/core-audio-driver.js";
import { PairingAuthService } from "./auth/pairing-auth.js";
import { getLanInfo } from "./network/lan-info.js";
import { installLaunchAgent, uninstallLaunchAgent, DEFAULT_SERVICE_LABEL } from "./service/launchd.js";

const args = process.argv.slice(2);
const command = args[0] || "start";

function getPort(): number {
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    return parseInt(args[portIdx + 1], 10);
  }
  return parseInt(process.env.PORT || "4818", 10);
}

const authService = new PairingAuthService();

async function showPairingInstructions(port: number, creds: { pin: string; bootstrapToken: string }) {
  const lan = getLanInfo(port, creds.bootstrapToken);
  console.log("\n========================================================");
  console.log("             MAC VOLUME REMOTE - PAIRING");
  console.log("========================================================\n");
  console.log("  Scan this QR code with your iPhone Camera to connect:\n");

  await new Promise<void>((resolve) => {
    qrcode.generate(lan.pairingUrl, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });

  console.log(`  Or open directly: ${lan.ipUrl} or ${lan.mDnsUrl}`);
  console.log(`  4-Digit PIN:      \x1b[1m\x1b[32m${creds.pin}\x1b[0m\n`);
  console.log("========================================================\n");
}

async function main() {
  const port = getPort();

  if (command === "start") {
    const creds = authService.getCredentials();
    const bridgePath = path.resolve("bin/audio-bridge");
    const audioDriver = new CoreAudioDriver({ bridgePath });
    const lan = getLanInfo(port, creds.bootstrapToken);

    const server = new AppServer({
      authService,
      audioDriver,
      hostName: lan.localHostName,
      port
    });

    const activePort = await server.start();
    await showPairingInstructions(activePort, creds);
    console.log(`[Mac Volume Remote] Server listening on http://0.0.0.0:${activePort}`);
    console.log("Press Ctrl+C to stop.");

    process.on("SIGINT", async () => {
      console.log("\nStopping server...");
      await server.stop();
      audioDriver.destroy();
      process.exit(0);
    });
  } else if (command === "pair") {
    let creds = authService.getCredentials();
    if (args.includes("--rotate")) {
      creds = authService.rotateCredentials();
      console.log("Rotated PIN and tokens successfully.");
    }
    await showPairingInstructions(port, creds);
  } else if (command === "service") {
    const sub = args[1];
    if (sub === "install") {
      const plistPath = installLaunchAgent(port);
      console.log(`Successfully installed launchd agent: ${plistPath}`);
      console.log("Mac Volume Remote will now auto-start when you log in!");
    } else if (sub === "uninstall") {
      const ok = uninstallLaunchAgent();
      if (ok) {
        console.log("Successfully uninstalled launchd agent.");
      } else {
        console.log("No launchd agent found to uninstall.");
      }
    } else {
      console.log("Usage: volremote service [install|uninstall]");
    }
  } else {
    console.log("Usage: volremote [start|pair|service]");
    console.log("  volremote start [--port 4818]   Start the remote server");
    console.log("  volremote pair [--rotate]       Display QR code and PIN");
    console.log("  volremote service install       Install background LaunchAgent");
    console.log("  volremote service uninstall     Uninstall background LaunchAgent");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
