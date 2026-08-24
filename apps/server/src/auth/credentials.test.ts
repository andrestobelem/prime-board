import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapCredentialPath,
  prepareBootstrapCredentialPath,
  storeBootstrapCredential,
} from "./credentials.ts";

describe("bootstrap credentials", () => {
  it("separa credenciales fallback por identidad de backend", () => {
    const home = join(tmpdir(), `prime-board-credentials-${crypto.randomUUID()}`);
    try {
      const postgresA = bootstrapCredentialPath(null, ":memory:|postgres:postgres://board-a", home);
      const postgresB = bootstrapCredentialPath(null, ":memory:|postgres:postgres://board-b", home);
      expect(postgresA).not.toBe(postgresB);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stores the key outside the project with private permissions", () => {
    const home = join(tmpdir(), `prime-board-credentials-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project with spaces");
    const credentialHome = join(home, "agent-home");
    mkdirSync(projectRoot, { recursive: true });
    try {
      const path = storeBootstrapCredential(
        projectRoot,
        ":memory:",
        "  pb_bootstrap_secret  ",
        credentialHome,
      );
      const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
      expect(path).toBe(join(credentialHome, ".prime-board", "credentials", `${hash}.json`));
      expect(path.startsWith(projectRoot)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe('{"apiKey":"pb_bootstrap_secret"}\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(credentialHome, ".prime-board", "credentials")).mode & 0o777).toBe(
        0o700,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rechaza un directorio de credenciales que no se puede preparar", () => {
    const home = join(tmpdir(), `prime-board-credentials-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project");
    const credentialsRoot = join(home, ".prime-board", "credentials");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(home, ".prime-board"), { recursive: true });
    writeFileSync(credentialsRoot, "not a directory");
    try {
      expect(() => prepareBootstrapCredentialPath(projectRoot, ":memory:", home)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked home root", () => {
    const realHome = join(tmpdir(), `prime-board-real-home-${crypto.randomUUID()}`);
    const linkedHome = join(tmpdir(), `prime-board-linked-home-${crypto.randomUUID()}`);
    const projectRoot = join(realHome, "project");
    mkdirSync(projectRoot, { recursive: true });
    symlinkSync(realHome, linkedHome);
    try {
      expect(() => bootstrapCredentialPath(projectRoot, ":memory:", linkedHome)).toThrow(
        "cannot contain a symlink",
      );
      expect(() => storeBootstrapCredential(projectRoot, ":memory:", "secret", linkedHome)).toThrow(
        "cannot contain a symlink",
      );
      expect(existsSync(join(realHome, ".prime-board"))).toBe(false);
    } finally {
      rmSync(linkedHome, { recursive: true, force: true });
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  it("rejects a symlink in the credential directory path", () => {
    const home = join(tmpdir(), `prime-board-symlink-home-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project");
    const redirectedDirectory = join(projectRoot, ".prime-board");
    mkdirSync(projectRoot, { recursive: true });
    symlinkSync(redirectedDirectory, join(home, ".prime-board"));
    try {
      expect(() => bootstrapCredentialPath(projectRoot, ":memory:", home)).toThrow(
        "cannot contain a symlink",
      );
      expect(() => storeBootstrapCredential(projectRoot, ":memory:", "secret", home)).toThrow(
        "cannot contain a symlink",
      );
      expect(existsSync(join(redirectedDirectory, "credentials"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlink in the credentials directory", () => {
    const home = join(tmpdir(), `prime-board-symlink-credentials-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project");
    const primeBoardDirectory = join(home, ".prime-board");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(primeBoardDirectory, { recursive: true });
    symlinkSync(projectRoot, join(primeBoardDirectory, "credentials"));
    try {
      expect(() => bootstrapCredentialPath(projectRoot, ":memory:", home)).toThrow(
        "cannot contain a symlink",
      );
      expect(() => storeBootstrapCredential(projectRoot, ":memory:", "secret", home)).toThrow(
        "cannot contain a symlink",
      );
      expect(readdirSync(projectRoot)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a project home that would place credentials in the project", () => {
    const projectRoot = join(tmpdir(), `prime-board-project-${crypto.randomUUID()}`);
    expect(() => bootstrapCredentialPath(projectRoot, ":memory:", projectRoot)).toThrow(
      "outside the project",
    );
  });
});
