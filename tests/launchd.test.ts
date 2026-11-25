import { describe, it, expect } from "vitest";
import { generateLaunchdPlist } from "../src/service/launchd.js";

describe("Launchd Plist Generator", () => {
  it("generates valid plist XML containing node path, entrypoint, and KeepAlive", () => {
    const plist = generateLaunchdPlist({
      label: "io.github.jeffureta.mac-volume-remote",
      nodeBin: "/usr/local/bin/node",
      cliScriptPath: "/Users/test/mac-volume-remote/dist/cli.js",
      port: 4818,
      logPath: "/Users/test/Library/Logs/mvr.log"
    });

    expect(plist).toContain("<string>io.github.jeffureta.mac-volume-remote</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>4818</string>");
  });
});
