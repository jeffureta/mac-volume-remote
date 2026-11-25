import { describe, it, expect } from "vitest";
import { getLanInfo, selectLanHost } from "../src/network/lan-info.js";

describe("LAN Info Resolution & Interface Selection", () => {
  it("resolves hostname and pairing URLs", () => {
    const info = getLanInfo(4818, "abcdef1234567890");
    expect(info.port).toBe(4818);
    expect(info.localHostName).toBeTruthy();
    expect(info.mDnsUrl).toContain(":4818");
    expect(info.pairingUrl).toContain("/?pair=abcdef1234567890");
  });

  it("prioritizes physical Wi-Fi/Ethernet (en0) over VPN virtual tunnels (utun4)", () => {
    const mockInterfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      utun4: [{ address: "10.5.0.2", family: "IPv4", internal: false }],
      en0: [{ address: "192.168.0.109", family: "IPv4", internal: false }]
    } as any;

    const selection = selectLanHost(mockInterfaces);
    expect(selection.lanIp).toBe("192.168.0.109");
    expect(selection.selectedInterface).toBe("en0");
    expect(selection.vpnInterfaces).toEqual(["utun4"]);
  });

  it("selects secondary Ethernet if en0 is missing or has only link-local IP", () => {
    const mockInterfaces = {
      en0: [{ address: "169.254.12.34", family: "IPv4", internal: false }],
      en1: [{ address: "192.168.1.55", family: "IPv4", internal: false }]
    } as any;

    const selection = selectLanHost(mockInterfaces);
    expect(selection.lanIp).toBe("192.168.1.55");
    expect(selection.selectedInterface).toBe("en1");
  });

  it("honors explicit override host if provided", () => {
    const mockInterfaces = {
      en0: [{ address: "192.168.0.109", family: "IPv4", internal: false }]
    } as any;

    const selection = selectLanHost(mockInterfaces, "my-custom-mac.local");
    expect(selection.lanIp).toBe("my-custom-mac.local");
    expect(selection.isOverride).toBe(true);
  });
});
