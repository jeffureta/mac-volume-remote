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
  maxOldSpaceSizeMb?: number;
}

export interface ServiceStatus {
  label: string;
  loaded: boolean;
  state: "running" | "not running" | "unloaded" | "unknown";
  pid?: number;
  bridgePid?: number;
  lastExitCode?: string;
  plistPath: string;
  logPath: string;
  port: number;
  cpuPercent?: number;
  rssMb?: number;
  healthOk?: boolean;
}

export interface PortConflict {
  command: string;
  pid: number;
  user: string;
}

export const DEFAULT_SERVICE_LABEL = "io.github.jeffureta.mac-volume-remote";
export const DEFAULT_LOG_MAX_BYTES = 256 * 1024; // 256 KB

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function rotateLogIfNeeded(logPath: string, maxSizeBytes: number = DEFAULT_LOG_MAX_BYTES): boolean {
  try {
    if (!fs.existsSync(logPath)) return false;
    const stat = fs.statSync(logPath);
    if (stat.size >= maxSizeBytes) {
      const backupPath = `${logPath}.1`;
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
      fs.renameSync(logPath, backupPath);
      fs.writeFileSync(logPath, "", "utf-8");
      return true;
    }
  } catch {}
  return false;
}

export function generateLaunchdPlist(config: LaunchdConfig): string {
  const workingDir = config.workingDir ?? PACKAGE_ROOT;
  const maxMem = config.maxOldSpaceSizeMb ?? 64;

  const escapedLabel = escapeXml(config.label);
  const escapedWorkingDir = escapeXml(workingDir);
  const escapedNodeBin = escapeXml(config.nodeBin);
  const escapedCliScript = escapeXml(config.cliScriptPath);
  const escapedLogPath = escapeXml(config.logPath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapedLabel}</string>
    <key>WorkingDirectory</key>
    <string>${escapedWorkingDir}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapedNodeBin}</string>
        <string>--max-old-space-size=${maxMem}</string>
        <string>${escapedCliScript}</string>
        <string>start</string>
        <string>--daemon</string>
        <string>--port</string>
        <string>${config.port}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>LowPriorityBackgroundIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ExitTimeOut</key>
    <integer>5</integer>
    <key>AbandonProcessGroup</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapedLogPath}</string>
    <key>StandardErrorPath</key>
    <string>${escapedLogPath}</string>
</dict>
</plist>
`;
}

export function parseLaunchctlPrint(output: string): {
  loaded: boolean;
  state: "running" | "not running" | "unloaded" | "unknown";
  pid?: number;
  lastExitCode?: string;
} {
  if (!output || output.includes("Could not find service") || output.includes("No such process")) {
    return { loaded: false, state: "unloaded" };
  }

  let pid: number | undefined;
  const pidMatch = output.match(/pid\s*=\s*(\d+)/i);
  if (pidMatch) {
    pid = parseInt(pidMatch[1], 10);
  }

  let lastExitCode: string | undefined;
  const exitMatch = output.match(/last exit code\s*=\s*(.+)/i);
  if (exitMatch) {
    lastExitCode = exitMatch[1].trim();
  }

  let state: "running" | "not running" | "unloaded" | "unknown" = "unknown";
  const stateMatch = output.match(/state\s*=\s*([a-zA-Z\s]+)/i);
  if (stateMatch) {
    const rawState = stateMatch[1].trim().toLowerCase();
    if (rawState.includes("running") && !rawState.includes("not")) {
      state = "running";
    } else if (rawState.includes("not running")) {
      state = "not running";
    }
  } else if (pid) {
    state = "running";
  }

  return { loaded: true, state, pid, lastExitCode };
}

export function parsePsMetrics(psOutput: string): { cpuPercent: number; rssMb: number } {
  let totalCpu = 0;
  let totalRssKb = 0;

  const lines = psOutput.split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const cpu = parseFloat(parts[0]);
      const rss = parseFloat(parts[1]);
      if (!Number.isNaN(cpu)) totalCpu += cpu;
      if (!Number.isNaN(rss)) totalRssKb += rss;
    }
  }

  return {
    cpuPercent: Math.round(totalCpu * 10) / 10,
    rssMb: Math.round((totalRssKb / 1024) * 10) / 10
  };
}

export function findPortConflict(
  port: number,
  runner: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: "utf-8" })
): PortConflict | null {
  try {
    const out = runner(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`);
    const lines = out.trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length >= 3) {
        return {
          command: parts[0],
          pid: parseInt(parts[1], 10),
          user: parts[2]
        };
      }
    }
  } catch {}
  return null;
}

export function getServicePaths(label: string = DEFAULT_SERVICE_LABEL): {
  plistPath: string;
  logPath: string;
} {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const logDir = path.join(os.homedir(), "Library", "Logs");
  const logPath = path.join(logDir, "mac-volume-remote.log");
  return { plistPath, logPath };
}

export function installLaunchAgent(
  port: number = 4818,
  options: { force?: boolean; label?: string } = {}
): string {
  const label = options.label ?? DEFAULT_SERVICE_LABEL;
  const { plistPath, logPath } = getServicePaths(label);
  const launchAgentsDir = path.dirname(plistPath);

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const cliScriptPath = resolvePackagePath("dist", "cli.js");
  const bridgePath = resolvePackagePath("bin", "audio-bridge");

  if (!fs.existsSync(cliScriptPath)) {
    throw new Error(`CLI build artifact missing: ${cliScriptPath}. Run "npm run build" first.`);
  }
  if (!fs.existsSync(bridgePath)) {
    throw new Error(`Audio bridge binary missing: ${bridgePath}. Run "npm run build" first.`);
  }

  // Preflight port conflict
  const conflict = findPortConflict(port);
  if (conflict) {
    if (options.force) {
      try {
        process.kill(conflict.pid, "SIGTERM");
      } catch {}
    } else {
      throw new Error(
        `Port ${port} is currently in use by process ${conflict.command} (PID ${conflict.pid}, user: ${conflict.user}). Stop it or pass --force.`
      );
    }
  }

  const nodeBin = process.execPath;
  const plistContent = generateLaunchdPlist({
    label,
    nodeBin,
    cliScriptPath,
    port,
    logPath,
    workingDir: PACKAGE_ROOT,
    maxOldSpaceSizeMb: 64
  });

  fs.writeFileSync(plistPath, plistContent, "utf-8");

  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`);
  } catch {}
  try {
    execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`);
    execSync(`launchctl enable gui/${uid}/${label} 2>/dev/null || true`);
  } catch {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
      execSync(`launchctl load "${plistPath}"`);
    } catch (e: any) {
      throw new Error(`Failed to load launchd agent: ${e.message}`);
    }
  }

  return plistPath;
}

export function uninstallLaunchAgent(label: string = DEFAULT_SERVICE_LABEL): boolean {
  const { plistPath } = getServicePaths(label);
  if (!fs.existsSync(plistPath)) return false;

  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`);
  } catch {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    } catch {}
  }

  try {
    fs.unlinkSync(plistPath);
  } catch {}
  return true;
}

export function startLaunchAgent(label: string = DEFAULT_SERVICE_LABEL): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const { plistPath } = getServicePaths(label);
  if (!fs.existsSync(plistPath)) {
    throw new Error(`LaunchAgent plist not found at ${plistPath}. Run "volremote service install" first.`);
  }
  try {
    execSync(`launchctl kickstart -k gui/${uid}/${label}`);
  } catch {
    execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`);
  }
}

export function stopLaunchAgent(label: string = DEFAULT_SERVICE_LABEL): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    execSync(`launchctl kill SIGTERM gui/${uid}/${label}`);
  } catch (err: any) {
    throw new Error(`Failed to stop service ${label}: ${err.message}`);
  }
}

export function restartLaunchAgent(label: string = DEFAULT_SERVICE_LABEL): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    execSync(`launchctl kickstart -k gui/${uid}/${label}`);
  } catch {
    startLaunchAgent(label);
  }
}

export function getLaunchAgentStatus(
  port: number = 4818,
  label: string = DEFAULT_SERVICE_LABEL
): ServiceStatus {
  const { plistPath, logPath } = getServicePaths(label);
  if (!fs.existsSync(plistPath)) {
    return {
      label,
      loaded: false,
      state: "unloaded",
      plistPath,
      logPath,
      port
    };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  let printOutput = "";
  try {
    printOutput = execSync(`launchctl print gui/${uid}/${label} 2>&1`, { encoding: "utf-8" });
  } catch (e: any) {
    printOutput = e.stdout || e.message || "";
  }

  const parsed = parseLaunchctlPrint(printOutput);
  let cpuPercent: number | undefined;
  let rssMb: number | undefined;
  let bridgePid: number | undefined;

  if (parsed.pid) {
    try {
      // Find child audio-bridge process if running
      const pgrep = execSync(`pgrep -P ${parsed.pid} audio-bridge 2>/dev/null || true`, {
        encoding: "utf-8"
      }).trim();
      if (pgrep) {
        bridgePid = parseInt(pgrep.split("\n")[0], 10);
      }

      const pids = [parsed.pid, bridgePid].filter(Boolean).join(",");
      const psOutput = execSync(`ps -o %cpu,rss -p ${pids} 2>/dev/null | tail -n +2`, {
        encoding: "utf-8"
      });
      const metrics = parsePsMetrics(psOutput);
      cpuPercent = metrics.cpuPercent;
      rssMb = metrics.rssMb;
    } catch {}
  }

  return {
    label,
    loaded: parsed.loaded,
    state: parsed.state,
    pid: parsed.pid,
    bridgePid,
    lastExitCode: parsed.lastExitCode,
    plistPath,
    logPath,
    port,
    cpuPercent,
    rssMb
  };
}

export function readServiceLogs(lines: number = 50, label: string = DEFAULT_SERVICE_LABEL): string {
  const { logPath } = getServicePaths(label);
  if (!fs.existsSync(logPath)) {
    return `No log file found at ${logPath}`;
  }
  try {
    return execSync(`tail -n ${lines} "${logPath}"`, { encoding: "utf-8" });
  } catch (err: any) {
    return `Failed to read log: ${err.message}`;
  }
}
