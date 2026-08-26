import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertRuntimeVersion(value: unknown): string {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`Runtime package version must be valid SemVer: ${String(value)}`);
  }
  return value;
}

function packageMetadataPath(): string {
  // La fuente corre desde src/ y el CLI compilado desde dist/. Ambos están bajo package.json.
  return join(import.meta.dir, "..", "package.json");
}

function readPackageVersion(): unknown {
  const raw = JSON.parse(readFileSync(packageMetadataPath(), "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw)).version;
}

export const RUNTIME_VERSION = assertRuntimeVersion(readPackageVersion());
