import { describe, it, expect } from "vitest";
import { resolvePackagePath, PACKAGE_ROOT } from "../src/shared/paths.js";
import fs from "node:fs";

describe("Package Paths Resolution", () => {
  it("resolves existing root files regardless of process.cwd", () => {
    expect(PACKAGE_ROOT).toBeTruthy();
    const pkgJsonPath = resolvePackagePath("package.json");
    expect(fs.existsSync(pkgJsonPath)).toBe(true);

    const publicIndexPath = resolvePackagePath("public", "index.html");
    expect(fs.existsSync(publicIndexPath)).toBe(true);
  });
});
