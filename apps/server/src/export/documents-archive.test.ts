import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDocumentRows,
  archiveDocumentSnapshot,
  verifyDocumentRows,
} from "./documents-archive.ts";

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pb-documents-archive-test-"));
}

describe("retired Documents archive", () => {
  it("writes a private manifest with count and checksum and merges sources", () => {
    const root = tempDirectory();
    try {
      const archivePath = join(root, "backup", "documents.archive.json");
      const sqliteRows = [{ id: "one", content: "private" }];
      const first = archiveDocumentRows(sqliteRows, archivePath, "sqlite");
      expect(first.sourceCount).toBe(1);
      expect(first.count).toBe(1);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(lstatSync(archivePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(archivePath, "utf8"))).toMatchObject({
        format: "prime-board.documents-archive",
        version: 1,
        count: 1,
        sources: { sqlite: { count: 1 } },
      });

      const second = archiveDocumentRows(
        [{ id: "two", content: "private" }],
        archivePath,
        "replica",
      );
      expect(second.count).toBe(2);
      expect(verifyDocumentRows(sqliteRows, archivePath, "sqlite").sourceCount).toBe(1);
      expect(() => verifyDocumentRows(sqliteRows, archivePath, "replica")).toThrow(
        /does not match/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza destinos dentro del repositorio y checksum incorrecto", () => {
    const root = tempDirectory();
    try {
      const repositoryRoot = join(root, "repository");
      const snapshot = join(repositoryRoot, ".prime-board", "meta", "documents.json");
      const archivePath = join(root, "documents.archive.json");
      mkdirSync(join(repositoryRoot, ".prime-board", "meta"), { recursive: true });
      writeFileSync(snapshot, '[{"title":"runbook","content":"secret"}]\n');
      expect(() =>
        archiveDocumentSnapshot(
          snapshot,
          join(repositoryRoot, "backup", "archive.json"),
          "replica",
          repositoryRoot,
        ),
      ).toThrow(/repository/);
      expect(() =>
        archiveDocumentSnapshot(
          snapshot,
          join(repositoryRoot, ".prime-board", "archive.json"),
          "replica",
          repositoryRoot,
        ),
      ).toThrow(/outside/);
      archiveDocumentSnapshot(snapshot, archivePath, "replica", repositoryRoot);
      expect(() =>
        verifyDocumentRows([{ title: "changed" }], archivePath, "replica", repositoryRoot),
      ).toThrow(/does not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza capturas de réplica que sean enlaces simbólicos", () => {
    const root = tempDirectory();
    try {
      const repositoryRoot = join(root, "repository");
      const snapshot = join(repositoryRoot, ".prime-board", "meta", "documents.json");
      const secretPath = join(root, "secret.json");
      mkdirSync(join(repositoryRoot, ".prime-board", "meta"), { recursive: true });
      writeFileSync(secretPath, '[{"title":"SECRET"}]\n');
      symlinkSync(secretPath, snapshot, "file");

      expect(() =>
        archiveDocumentSnapshot(
          snapshot,
          join(root, "documents.archive.json"),
          "replica",
          repositoryRoot,
        ),
      ).toThrow(/symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechaza un directorio padre symlinked y archivos de archivo no privados", () => {
    const root = tempDirectory();
    try {
      const protectedDirectory = join(root, ".prime-board");
      const linkedDirectory = join(root, "linked");
      const archivePath = join(root, "backup", "documents.archive.json");
      mkdirSync(protectedDirectory, { recursive: true });
      symlinkSync(protectedDirectory, linkedDirectory, "dir");
      expect(() =>
        archiveDocumentRows([{ id: "one" }], join(linkedDirectory, "archive.json"), "sqlite"),
      ).toThrow(/outside/);
      const brokenOutput = join(root, "broken.archive.json");
      symlinkSync(join(root, "missing.archive.json"), brokenOutput);
      expect(() => archiveDocumentRows([{ id: "one" }], brokenOutput, "sqlite")).toThrow(
        /symbolic link/,
      );

      archiveDocumentRows([{ id: "one" }], archivePath, "sqlite");
      chmodSync(archivePath, 0o644);
      expect(() => verifyDocumentRows([{ id: "one" }], archivePath, "sqlite")).toThrow(/0600/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
