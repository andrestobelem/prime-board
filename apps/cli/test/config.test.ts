import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("CLI credential configuration", () => {
  it("creates a private config directory and file", () => {
    const home = mkdtempSync(join(tmpdir(), "pb-cli-config-"));
    try {
      const script = `
        import { saveConfig, CONFIG_PATH } from "./apps/cli/src/config.ts";
        await saveConfig({ url: "http://example.invalid", apiKey: "pb_test_secret" });
        console.log(CONFIG_PATH);
      `;
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
      });
      expect(result.exitCode).toBe(0);
      const configPath = result.stdout.toString().trim();
      expect(statSync(join(home, ".prime-board")).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("hardens permissions of an existing config when loading", () => {
    const home = mkdtempSync(join(tmpdir(), "pb-cli-config-"));
    try {
      const script = `
        import { chmodSync } from "node:fs";
        import { CONFIG_DIR, CONFIG_PATH, loadConfig, saveConfig } from "./apps/cli/src/config.ts";
        await saveConfig({ url: "http://example.invalid", apiKey: "pb_test_secret" });
        chmodSync(CONFIG_DIR, 0o755);
        chmodSync(CONFIG_PATH, 0o644);
        await loadConfig();
        console.log(CONFIG_PATH);
      `;
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
      });
      expect(result.exitCode).toBe(0);
      const configPath = result.stdout.toString().trim();
      expect(statSync(join(home, ".prime-board")).mode & 0o777).toBe(0o700);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
