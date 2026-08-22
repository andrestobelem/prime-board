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

  it("mantiene perfiles separados y cambia el perfil efectivo", () => {
    const home = mkdtempSync(join(tmpdir(), "pb-cli-profiles-"));
    try {
      const script = `
        import { listProfiles, loadConfig, saveConfig, selectProfile } from "./apps/cli/src/config.ts";
        await saveConfig({ url: "http://one.invalid", apiKey: "pb_one", workspaceId: "workspace-one", workspaceUrlKey: "one" }, "one");
        await saveConfig({ url: "http://two.invalid", apiKey: "pb_two" }, "two");
        const before = await loadConfig("one");
        await selectProfile("two");
        const after = await loadConfig();
        console.log(JSON.stringify({ before, after, profiles: await listProfiles() }));
      `;
      const env = { ...process.env };
      delete env.PRIME_BOARD_URL;
      delete env.PRIME_BOARD_API_KEY;
      delete env.PRIME_BOARD_PROFILE;
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: ROOT,
        env: { ...env, HOME: home },
      });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.toString());
      expect(output.before).toMatchObject({
        profile: "one",
        url: "http://one.invalid",
        apiKey: "pb_one",
        workspaceId: "workspace-one",
        workspaceUrlKey: "one",
      });
      expect(output.after).toMatchObject({
        profile: "two",
        url: "http://two.invalid",
        apiKey: "pb_two",
      });
      expect(output.profiles.map((profile: { name: string }) => profile.name)).toEqual([
        "one",
        "two",
      ]);
      expect(output.profiles[0]).toMatchObject({
        name: "one",
        workspaceId: "workspace-one",
        workspaceUrlKey: "one",
      });
      expect(JSON.stringify(output.profiles)).not.toContain("pb_one");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
