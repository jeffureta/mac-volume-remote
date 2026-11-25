import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateLaunchdPlist,
  rotateLogIfNeeded,
  parseLaunchctlPrint,
  parsePsMetrics,
  findPortConflict,
  LaunchdConfig
} from "../src/service/launchd.js";

describe("Hardened Launchd Plist Generator", () => {
  it("generates hardened plist XML with Apple Silicon efficiency keys and memory limits", () => {
    const config: LaunchdConfig = {
      label: "io.github.jeffureta.mac-volume-remote",
      nodeBin: "/opt/homebrew/bin/node",
      cliScriptPath: "/Users/test/mac-volume-remote/dist/cli.js",
      port: 4818,
      logPath: "/Users/test/Library/Logs/mvr.log",
      workingDir: "/Users/test/mac-volume-remote",
      maxOldSpaceSizeMb: 64
    };

    const plist = generateLaunchdPlist(config);

    // Identity and arguments
    expect(plist).toContain("<string>io.github.jeffureta.mac-volume-remote</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>--max-old-space-size=64</string>");
    expect(plist).toContain("<string>--daemon</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>4818</string>");

    // Apple Silicon Efficiency Core hints
    expect(plist).toContain("<key>ProcessType</key>\n    <string>Background</string>");
    expect(plist).toContain("<key>LowPriorityIO</key>\n    <true/>");
    expect(plist).toContain("<key>LowPriorityBackgroundIO</key>\n    <true/>");
    expect(plist).toContain("<key>Nice</key>\n    <integer>10</integer>");

    // Reliability & Session isolation
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
    expect(plist).toContain("<key>LimitLoadToSessionType</key>\n    <string>Aqua</string>");
    expect(plist).toContain("<key>ExitTimeOut</key>\n    <integer>5</integer>");
    expect(plist).toContain("<key>AbandonProcessGroup</key>\n    <false/>");
  });

  it("escapes special XML characters in paths and labels", () => {
    const plist = generateLaunchdPlist({
      label: "test & <label>",
      nodeBin: "/bin/node",
      cliScriptPath: "/path/with & <chars>",
      port: 4818,
      logPath: "/logs/test & <out>.log"
    });

    expect(plist).toContain("test &amp; &lt;label&gt;");
    expect(plist).toContain("/path/with &amp; &lt;chars&gt;");
    expect(plist).toContain("/logs/test &amp; &lt;out&gt;.log");
  });
});

describe("Bounded Log Rotation", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mvr-log-test-"));
    logFile = path.join(tmpDir, "test.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves log file untouched when size is below maxSizeBytes", () => {
    fs.writeFileSync(logFile, "Small log line\n");
    const rotated = rotateLogIfNeeded(logFile, 1024);
    expect(rotated).toBe(false);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
  });

  it("rotates log file to .1 when size exceeds maxSizeBytes", () => {
    const largeData = "X".repeat(2048);
    fs.writeFileSync(logFile, largeData);

    const rotated = rotateLogIfNeeded(logFile, 1024);
    expect(rotated).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.statSync(`${logFile}.1`).size).toBe(2048);
    // New fresh log created
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.statSync(logFile).size).toBe(0);
  });
});

describe("Launchctl & Process Metrics Parsing", () => {
  it("parses launchctl print output accurately for active service", () => {
    const sampleOutput = `
gui/501/io.github.jeffureta.mac-volume-remote = {
	active count = 1
	path = /Users/test/Library/LaunchAgents/io.github.jeffureta.mac-volume-remote.plist
	state = running
	program = /opt/homebrew/bin/node
	arguments = {
		/opt/homebrew/bin/node
		--max-old-space-size=64
		/Users/test/mac-volume-remote/dist/cli.js
		start
		--daemon
		--port
		4818
	}
	pid = 91823
	last exit code = (never exited)
}
`;
    const info = parseLaunchctlPrint(sampleOutput);
    expect(info.loaded).toBe(true);
    expect(info.state).toBe("running");
    expect(info.pid).toBe(91823);
    expect(info.lastExitCode).toBe("(never exited)");
  });

  it("parses launchctl print output for stopped or unloaded service", () => {
    const stoppedOutput = `
gui/501/io.github.jeffureta.mac-volume-remote = {
	state = not running
	last exit code = 0
}
`;
    const stoppedInfo = parseLaunchctlPrint(stoppedOutput);
    expect(stoppedInfo.loaded).toBe(true);
    expect(stoppedInfo.state).toBe("not running");
    expect(stoppedInfo.pid).toBeUndefined();
    expect(stoppedInfo.lastExitCode).toBe("0");

    const missingInfo = parseLaunchctlPrint("Could not find service");
    expect(missingInfo.loaded).toBe(false);
    expect(missingInfo.state).toBe("unloaded");
  });

  it("parses ps output to aggregate combined RSS and CPU metrics", () => {
    const psLines = "  12.5   8192\n   2.1   4096";
    const metrics = parsePsMetrics(psLines);
    expect(metrics.cpuPercent).toBeCloseTo(14.6);
    expect(metrics.rssMb).toBeCloseTo(12.0); // (8192 + 4096) / 1024
  });
});

describe("Port Conflict Detection", () => {
  it("identifies port conflicts using mocked or real output", () => {
    const lsofOutput = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    81631 jeffureta   22u  IPv4 0x123      0t0  TCP *:4818 (LISTEN)";
    const conflict = findPortConflict(4818, () => lsofOutput);
    expect(conflict).not.toBeNull();
    expect(conflict?.pid).toBe(81631);
    expect(conflict?.command).toBe("node");

    const noConflict = findPortConflict(4818, () => "");
    expect(noConflict).toBeNull();
  });
});
