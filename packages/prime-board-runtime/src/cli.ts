#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseRuntimeArgs } from "./options.ts";

const HELP = `prime-board runtime

Usage: prime-board [--db PATH] [--repo PATH] [--port PORT] [--web-dist PATH]

Options:
  --db PATH       SQLite database path
  --repo PATH     Repository Replica root
  --port PORT     HTTP port (1-65535)
  --web-dist PATH Static UI directory
  --help          Show this help

Environment:
  PRIME_BOARD_AUTH_MODE=local  Loopback-only mode without an API key
`;

let options;
try {
  options = parseRuntimeArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const env = { ...process.env };
if (options.dbPath) env.PRIME_BOARD_DB = options.dbPath;
if (options.repoRoot) env.PRIME_BOARD_REPO = options.repoRoot;
if (options.port !== undefined) env.PRIME_BOARD_PORT = String(options.port);
if (options.webDist) env.PRIME_BOARD_WEB_DIST = options.webDist;
else env.PRIME_BOARD_WEB_DIST ??= join(import.meta.dir, "web");

const server = spawn(process.execPath, [join(import.meta.dir, "server.js")], {
  env,
  stdio: "inherit",
});
const forwardSignal = (signal: NodeJS.Signals) => server.kill(signal);
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
server.once("error", (error) => {
  console.error(`Failed to start prime-board server: ${error.message}`);
  process.exitCode = 1;
});
server.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
