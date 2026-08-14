// Configuración del CLI: ~/.prime-board/cli.json con override por env (spec §7).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { UsageError } from "./errors.ts";

export interface CliConfig {
  url: string;
  apiKey: string;
}

export const CONFIG_PATH = join(homedir(), ".prime-board", "cli.json");

export async function loadConfig(): Promise<CliConfig> {
  let fileConfig: Partial<CliConfig> = {};
  const file = Bun.file(CONFIG_PATH);
  if (await file.exists()) {
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
  mkdirSync(join(homedir(), ".prime-board"), { recursive: true });
  await Bun.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
