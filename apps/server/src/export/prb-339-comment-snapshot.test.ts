// PRB-339: un comentario no puede omitir el snapshot de un issue nuevo.
import { afterAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/database.ts";
import { createTestApp, gql } from "../test-helpers.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";

const app = createTestApp();
const root = mkdtempSync(join(tmpdir(), "pb-prb339-"));

afterAll(() => {
  app.stop();
  rmSync(root, { recursive: true, force: true });
});

it("escribe snapshot y reconstruye un issue cuya última actividad es un comentario", async () => {
  const created = await gql(
    app,
    `mutation { issueCreate(input: { teamKey: "PB", title: "Commented snapshot" }) { issue { id } } }`,
  );
  const issueId = created.data!.issueCreate.issue.id as string;
  exportBoard(app.db, root);
  const snapshotPath = join(root, ".prime-board", "issues", "PB-1.md");
  expect(existsSync(snapshotPath)).toBe(true);
  const beforeComment = readFileSync(snapshotPath, "utf8");

  await gql(
    app,
    `mutation($id: ID!) { commentCreate(input: { issueId: $id, body: "preserve me" }) { success } }`,
    { id: issueId },
  );
  exportBoard(app.db, root);
  const afterComment = readFileSync(snapshotPath, "utf8");
  expect(afterComment).toContain("Commented snapshot");
  expect(afterComment).not.toBe(beforeComment);

  const fresh = new Database(":memory:", { strict: true });
  try {
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    const rebuilt = rebuildFromRepo(fresh, root);
    expect(rebuilt.issues).toBe(1);
    expect(rebuilt.comments).toBe(1);
  } finally {
    fresh.close();
  }
});
