import path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(CURRENT_DIR, "../..");

export function resolvePackagePath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}
