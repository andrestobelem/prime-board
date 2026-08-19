#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const packageRoot = join(repoRoot, "packages", "prime-board-runtime");
const dist = join(packageRoot, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

function run(command: string[], cwd = repoRoot): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0)
    throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
}

run([process.execPath, "run", "--cwd", "apps/web", "build"]);
run([
  process.execPath,
  "build",
  "apps/server/src/index.ts",
  "--target",
  "bun",
  "--outfile",
  join(dist, "server.js"),
]);
run([
  process.execPath,
  "build",
  join(packageRoot, "src/cli.ts"),
  "--target",
  "bun",
  "--outfile",
  join(dist, "cli.js"),
]);
cpSync(join(repoRoot, "apps", "web", "dist"), join(dist, "web"), { recursive: true });
console.log(`Built @prime-board/runtime in ${dist}`);
