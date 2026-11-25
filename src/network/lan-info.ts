import os from "node:os";
import { execSync } from "node:child_process";

export interface LanInfo {
  port: number;
  localHostName: string;
  lanIp: string;
  mDnsUrl: string;
  ipUrl: string;
  pairingUrl: string;
}

export function getLanInfo(port: number, bootstrapToken: string): LanInfo {
  let localHostName = os.hostname().replace(/\.local$/, "");
  try {
    const raw = execSync("scutil --get LocalHostName 2>/dev/null", { encoding: "utf-8" }).trim();
    if (raw) localHostName = raw;
  } catch {
    // fallback to os.hostname
  }

  let lanIp = "127.0.0.1";
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        lanIp = iface.address;
        break;
      }
    }
  }

  const mDnsUrl = `http://${localHostName}.local:${port}`;
  const ipUrl = `http://${lanIp}:${port}`;
  const pairingUrl = `${ipUrl}/?pair=${bootstrapToken}`;

  return {
    port,
    localHostName,
    lanIp,
    mDnsUrl,
    ipUrl,
    pairingUrl
  };
}
