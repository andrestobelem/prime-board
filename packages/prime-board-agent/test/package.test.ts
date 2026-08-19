import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  type: string;
  keywords?: string[];
  files?: string[];
  pi?: { extensions?: string[]; skills?: string[] };
};

describe("Prime Agent package", () => {
  it("declares the public pi resources", () => {
    expect(manifest.name).toBe("@prime-board/agent");
    expect(manifest.version).toBeTruthy();
    expect(manifest.type).toBe("module");
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./extensions"],
      skills: ["./skills"],
    });
    expect(manifest.files).toEqual(expect.arrayContaining(["extensions", "skills", "README.md"]));
  });

  it("keeps manifest resources discoverable at their declared paths", () => {
    for (const resourcePath of manifest.pi?.extensions ?? []) {
      expect(statSync(join(PACKAGE_ROOT, resourcePath)).isDirectory()).toBe(true);
      expect(Bun.file(join(PACKAGE_ROOT, resourcePath, "index.ts")).size).toBeGreaterThan(0);
    }
    for (const resourcePath of manifest.pi?.skills ?? []) {
      expect(statSync(join(PACKAGE_ROOT, resourcePath)).isDirectory()).toBe(true);
      expect(
        Bun.file(join(PACKAGE_ROOT, resourcePath, "prime-board-workflow", "SKILL.md")).size,
      ).toBeGreaterThan(0);
    }
  });

  it("loads the extension through its public factory seam", async () => {
    const extension = await import(join(PACKAGE_ROOT, "extensions", "index.ts"));
    const commands: string[] = [];
    const tools: string[] = [];
    extension.default({
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(definition: { name: string }) {
        tools.push(definition.name);
      },
    });
    expect(commands).toEqual(["prime-board"]);
    expect(tools).toEqual(["prime_board_status"]);
  });

  it("discovers the enclosing Git project through the public status seam", async () => {
    const extension = await import(join(PACKAGE_ROOT, "extensions", "index.ts"));
    expect(extension.discoverPrimeBoardProject(PACKAGE_ROOT)).toBe(resolve(PACKAGE_ROOT, "../.."));

    const status = await extension.getPrimeBoardStatus(PACKAGE_ROOT, "not a URL");
    expect(status).toMatchObject({
      projectRoot: resolve(PACKAGE_ROOT, "../.."),
      state: "unavailable",
      detail: "Invalid server URL",
    });
  });
  it("installs and lists the package through Prime Agent when available", () => {
    const primeAgent = Bun.which("prime-agent");
    if (!primeAgent) return;

    const project = mkdtempSync(join(tmpdir(), "prime-board-agent-install-"));
    try {
      const env = { ...process.env, HOME: project };
      const install = Bun.spawnSync([primeAgent, "package", "install", PACKAGE_ROOT, "--local"], {
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(install.exitCode).toBe(0);

      const settings = JSON.parse(
        readFileSync(join(project, ".prime", "agent", "settings.json"), "utf8"),
      ) as { packages?: string[] };
      expect(settings.packages).toHaveLength(1);

      const listed = Bun.spawnSync([primeAgent, "package", "list"], {
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain(PACKAGE_ROOT);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
