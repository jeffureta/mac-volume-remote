import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { resolvePackagePath, PACKAGE_ROOT } from "../shared/paths.js";

export interface LaunchdConfig {
  label: string;
  nodeBin: string;
  cliScriptPath: string;
  port: number;
  logPath: string;
  workingDir?: string;
}

export const DEFAULT_SERVICE_LABEL = "io.github.jeffureta.mac-volume-remote";

export function generateLaunchdPlist(config: LaunchdConfig): string {
  const workingDir = config.workingDir ?? PACKAGE_ROOT;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${config.label}</string>
    <key>WorkingDirectory</key>
    <string>${workingDir}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${config.nodeBin}</string>
        <string>${config.cliScriptPath}</string>
        <string>start</string>
        <string>--port</string>
        <string>${config.port}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${config.logPath}</string>
    <key>StandardErrorPath</key>
    <string>${config.logPath}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(port: number = 4818): string {
  const label = DEFAULT_SERVICE_LABEL;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const logDir = path.join(os.homedir(), "Library", "Logs");
  const logPath = path.join(logDir, "mac-volume-remote.log");

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const nodeBin = process.execPath;
  const cliScriptPath = resolvePackagePath("dist", "cli.js");

  const plistContent = generateLaunchdPlist({
    label,
    nodeBin,
    cliScriptPath,
    port,
    logPath,
    workingDir: PACKAGE_ROOT
  });

  fs.writeFileSync(plistPath, plistContent, "utf-8");

  try {
    const uid = process.getuid ? process.getuid() : 501;
    execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`);
    execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`);
  } catch {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    execSync(`launchctl load "${plistPath}"`);
  }

  return plistPath;
}

export function uninstallLaunchAgent(): boolean {
  const label = DEFAULT_SERVICE_LABEL;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (!fs.existsSync(plistPath)) return false;

  try {
    const uid = process.getuid ? process.getuid() : 501;
    execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`);
  } catch {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
  }

  fs.unlinkSync(plistPath);
  return true;
}
