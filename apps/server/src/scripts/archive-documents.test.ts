import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");

function cleanEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

describe("archive:documents", () => {
  it("valida la raíz PRIME_BOARD_REPO configurada", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-archive-documents-cli-"));
    const databasePath = join(root, "board.sqlite");
    const configuredRepository = join(root, "configured-repository");
    const archivePath = join(configuredRepository, "backup", "documents.archive.json");
    mkdirSync(configuredRepository, { recursive: true });
    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL
        );
        INSERT INTO documents (id, title, content)
        VALUES ('legacy-document', 'Legacy', 'private');
      `);
      database.close();

      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "archive-documents.ts"), "--out", archivePath],
        {
          cwd: repositoryRoot,
          env: {
            ...cleanEnvironment(),
            PRIME_BOARD_DB: databasePath,
            PRIME_BOARD_PERSISTENCE: "sqlite",
            PRIME_BOARD_REPO: configuredRepository,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).toMatch(
        /outside the repository/,
      );
      expect(existsSync(archivePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
