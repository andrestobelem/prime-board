// Configuración del CLI: ~/.prime-board/cli.json con override por env (spec §7).
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./errors.ts";

export interface CliConfig {
  url: string;
  apiKey: string;
}

export const CONFIG_DIR = join(homedir(), ".prime-board");
export const CONFIG_PATH = join(CONFIG_DIR, "cli.json");

function hardenPermissions(): void {
  chmodSync(CONFIG_DIR, 0o700);
  chmodSync(CONFIG_PATH, 0o600);
}

export async function loadConfig(): Promise<CliConfig> {
  let fileConfig: Partial<CliConfig> = {};
  const file = Bun.file(CONFIG_PATH);
  if (await file.exists()) {
    hardenPermissions();
    fileConfig = (await file.json()) as Partial<CliConfig>;
  }
  const url = process.env.PRIME_BOARD_URL ?? fileConfig.url;
  const apiKey = process.env.PRIME_BOARD_API_KEY ?? fileConfig.apiKey;
  if (!url || !apiKey) {
    throw new UsageError(
      "Missing credentials. Run `pb auth login --url <url> --key <api-key>` " +
        "or set PRIME_BOARD_URL and PRIME_BOARD_API_KEY.",
    );
  }
  return { url, apiKey };
}

export async function saveConfig(config: CliConfig): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);

  const temporaryPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, CONFIG_PATH);
    chmodSync(CONFIG_PATH, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
