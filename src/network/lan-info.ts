import os from "node:os";
import { execSync } from "node:child_process";

export interface LanSelection {
  lanIp: string;
  selectedInterface: string;
  vpnInterfaces: string[];
  isOverride: boolean;
}

export interface LanInfo extends LanSelection {
  port: number;
  localHostName: string;
  mDnsUrl: string;
  ipUrl: string;
  pairingUrl: string;
}

const VIRTUAL_PREFIXES = [
  "utun", "tun", "tap", "ppp", "wg", "ipsec", "awdl", "llw",
  "bridge", "anpi", "lo", "docker", "veth", "tailscale"
];

function isVirtualOrVpn(ifaceName: string): boolean {
  const lower = ifaceName.toLowerCase();
  return VIRTUAL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function isValidIpv4(address: string): boolean {
  if (!address || address.startsWith("127.") || address.startsWith("169.254.")) {
    return false;
  }
  return true;
}

export function selectLanHost(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  overrideHost?: string
): LanSelection {
  if (overrideHost && overrideHost.trim()) {
    return {
      lanIp: overrideHost.trim(),
      selectedInterface: "override",
      vpnInterfaces: [],
      isOverride: true
    };
  }

  const vpnInterfaces: string[] = [];
  const physicalCandidates: Array<{ name: string; ip: string; priority: number }> = [];
  const otherCandidates: Array<{ name: string; ip: string }> = [];

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name] || [];
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (isVirtualOrVpn(name)) {
          vpnInterfaces.push(name);
        } else if (isValidIpv4(iface.address)) {
          if (name.startsWith("en")) {
            // Priority: en0 = 0, en1 = 1, etc.
            const idx = parseInt(name.replace("en", ""), 10);
            physicalCandidates.push({
              name,
              ip: iface.address,
              priority: Number.isNaN(idx) ? 99 : idx
            });
          } else {
            otherCandidates.push({ name, ip: iface.address });
          }
        }
      }
    }
  }

  if (physicalCandidates.length > 0) {
    physicalCandidates.sort((a, b) => a.priority - b.priority);
    const chosen = physicalCandidates[0];
    return {
      lanIp: chosen.ip,
      selectedInterface: chosen.name,
      vpnInterfaces,
      isOverride: false
    };
  }

  if (otherCandidates.length > 0) {
    const chosen = otherCandidates[0];
    return {
      lanIp: chosen.ip,
      selectedInterface: chosen.name,
      vpnInterfaces,
      isOverride: false
    };
  }

  return {
    lanIp: "127.0.0.1",
    selectedInterface: "lo0",
    vpnInterfaces,
    isOverride: false
  };
}

export function getLanInfo(
  port: number,
  bootstrapToken: string,
  options: { overrideHost?: string; interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]> } = {}
): LanInfo {
  let localHostName = os.hostname().replace(/\.local$/, "");
  try {
    const raw = execSync("scutil --get LocalHostName 2>/dev/null", { encoding: "utf-8" }).trim();
    if (raw) localHostName = raw;
  } catch {
    // fallback
  }

  const ifaces = options.interfaces ?? os.networkInterfaces();
  const selection = selectLanHost(ifaces, options.overrideHost);

  const mDnsUrl = `http://${localHostName}.local:${port}`;
  const ipUrl = `http://${selection.lanIp}:${port}`;
  const pairingUrl = `${ipUrl}/?pair=${bootstrapToken}`;

  return {
    ...selection,
    port,
    localHostName,
    mDnsUrl,
    ipUrl,
    pairingUrl
  };
}
