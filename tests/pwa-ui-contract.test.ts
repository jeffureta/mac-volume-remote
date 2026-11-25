import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PUBLIC_DIR = path.resolve("public");

function parsePngHeader(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const magic = buf.subarray(0, 8);
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return {
    isPng: magic.equals(expectedMagic),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf.readUInt8(25)
  };
}

describe("PWA Mobile UI, Removed Buttons, and iOS Home Screen Icons", () => {
  it("removes step (-5%, -1%, +1%, +5%) and preset (25%-100%) buttons while keeping pillar and Mute", () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");

    expect(html).not.toContain("stepDown5");
    expect(html).not.toContain("stepDown1");
    expect(html).not.toContain("stepUp1");
    expect(html).not.toContain("stepUp5");
    expect(html).not.toContain("preset-btn");
    expect(html).not.toContain("-5%");
    expect(html).not.toContain(">25%<");
    expect(html).not.toContain(">75%<");
    expect(html).not.toContain(">100%<");

    expect(html).toContain('id="pillar"');
    expect(html).toContain('id="muteBtn"');
    expect(html).toContain('id="volumeText" class="pillar-label">--%<');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Mac Volume">');
  });

  it("configures manifest.webmanifest for Mac Volume with PNG icons", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf-8")
    );

    expect(manifest.short_name).toBe("Mac Volume");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
    ]);
  });

  it("provides opaque valid PNG Home Screen icons at 180x180, 192x192, and 512x512", () => {
    const specs = [
      { name: "apple-touch-icon.png", size: 180 },
      { name: "icon-192.png", size: 192 },
      { name: "icon-512.png", size: 512 }
    ];

    for (const spec of specs) {
      const fullPath = path.join(PUBLIC_DIR, spec.name);
      expect(fs.existsSync(fullPath)).toBe(true);
      const header = parsePngHeader(fullPath);
      expect(header.isPng).toBe(true);
      expect(header.width).toBe(spec.size);
      expect(header.height).toBe(spec.size);
      // Color type 2 = truecolor RGB (opaque, no alpha channel)
      expect(header.colorType).toBe(2);
    }
  });

  it("enforces mobile-friendly safe-area, no-bounce, and iPhone SE 2022 viewport CSS", () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf-8");

    expect(css).toContain("overscroll-behavior: none");
    expect(css).toContain("max(");
    expect(css).toContain("@media (max-height: 700px)");
    expect(css).not.toContain(".preset-btn");
    // Ensure diagnostics modal .btn-row stays intact
    expect(css).toContain(".btn-row");
  });
});
