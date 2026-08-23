#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const packageRoot = join(repoRoot, "packages", "prime-board-runtime");
const dist = join(packageRoot, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

function run(command: string[], cwd = repoRoot): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
  }
}

run(
  [
    process.execPath,
    join(repoRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js"),
    "build",
  ],
  join(repoRoot, "apps", "web"),
);
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
// Keep migrations as inspectable release assets. The server embeds the same SQL during bundling.
cpSync(join(repoRoot, "apps", "server", "src", "db", "migrations"), join(dist, "migrations"), {
  recursive: true,
});

interface ReleaseFile {
  path: string;
  sha256: string;
  bytes: number;
}

function releaseFiles(root: string, current = root): ReleaseFile[] {
  const result: ReleaseFile[] = [];
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    if (statSync(path).isDirectory()) result.push(...releaseFiles(root, path));
    else {
      const bytes = readFileSync(path);
      result.push({
        path: relative(root, path).replaceAll("\\", "/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

const files = releaseFiles(dist);
writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify(
    {
      format: 1,
      bun: ">=1.3.14",
      backend: "sqlite",
      platform: "bun-runtime",
      files,
      notes: [
        "The SQLite database and Repository Replica are runtime data, not package files.",
        "Use a backup before package updates; migrations are forward-only and restore from the backup on failure.",
      ],
    },
    null,
    2,
  )}\n`,
);
const checksums = files.map((file) => `${file.sha256}  ${file.path}`).join("\n");
writeFileSync(join(dist, "checksums.txt"), `${checksums}\n`);
console.log(`Built @prime-board/runtime in ${dist}`);
