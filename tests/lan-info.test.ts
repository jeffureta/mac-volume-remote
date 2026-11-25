import { describe, it, expect } from "vitest";
import { getLanInfo } from "../src/network/lan-info.js";

describe("LAN Info Resolution", () => {
  it("resolves hostname and pairing URLs", () => {
    const info = getLanInfo(4818, "abcdef1234567890");
    expect(info.port).toBe(4818);
    expect(info.localHostName).toBeTruthy();
    expect(info.mDnsUrl).toContain(":4818");
    expect(info.pairingUrl).toContain("/?pair=abcdef1234567890");
  });
});
