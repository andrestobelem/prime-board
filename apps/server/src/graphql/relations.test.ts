// Tests de AT-175: relación blocked-by de punta a punta.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;

beforeAll(async () => {
  app = createTestApp();
  for (const title of ["Uno", "Dos", "Tres"]) {
    await gql(app, `mutation($t: String!) {
      issueCreate(input: { teamKey: "PB", title: $t }) { success }
    }`, { t: title });
  }
});

afterAll(() => app.stop());

const RELATIONS_QUERY = `query($id: ID!) {
  issue(id: $id) { relations { id type relatedIssue { identifier } } }
}`;

async function relationsOf(ref: string) {
  const result = await gql(app, RELATIONS_QUERY, { id: ref });
  return result.data!.issue.relations as Array<{ id: string; type: string; relatedIssue: { identifier: string } }>;
}

async function createRelation(issueId: string, relatedIssueId: string, type: string) {
  return gql(app, `mutation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success relation { id type relatedIssue { identifier } } }
  }`, { input: { issueId, relatedIssueId, type } });
}

describe("issue relations (blocked-by)", () => {
  it("crea una relación y se lee desde ambos extremos con tipos inversos", async () => {
    const created = await createRelation("PB-1", "PB-2", "BLOCKED_BY");
    expect(created.errors).toBeUndefined();
    expect(created.data!.issueRelationCreate.relation).toMatchObject({
      type: "BLOCKED_BY",
      relatedIssue: { identifier: "PB-2" },
    });

    expect(await relationsOf("PB-1")).toMatchObject([
      { type: "BLOCKED_BY", relatedIssue: { identifier: "PB-2" } },
    ]);
    expect(await relationsOf("PB-2")).toMatchObject([
      { type: "BLOCKS", relatedIssue: { identifier: "PB-1" } },
    ]);
  });

  it("BLOCKS se normaliza a la misma fila canónica que BLOCKED_BY", async () => {
    // PB-1 blocked by PB-2 ya existe; expresarla desde el otro extremo es duplicado.
    const duplicate = await createRelation("PB-2", "PB-1", "BLOCKS");
    expect(duplicate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const row = app.db.query("SELECT * FROM issue_relations").all() as Array<Record<string, unknown>>;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ type: "blocks" });
  });

  it("rechaza relacionar un issue consigo mismo", async () => {
    const result = await createRelation("PB-1", "PB-1", "BLOCKED_BY");
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rechaza duplicados exactos", async () => {
    const result = await createRelation("PB-1", "PB-2", "BLOCKED_BY");
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rechaza issues inexistentes", async () => {
    const result = await createRelation("PB-1", "PB-999", "BLOCKED_BY");
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("registra la relación en la actividad de ambos issues", async () => {
    const activity = await gql(app, `query($id: ID!) {
      issue(id: $id) { activity { type payload } }
    }`, { id: "PB-2" });
    const events = activity.data!.issue.activity.filter((e: any) => e.type === "relation_added");
    expect(events).toMatchObject([{ payload: { type: "blocks", issue: "PB-1" } }]);
  });

  it("borra la relación y desaparece de los dos extremos", async () => {
    const extra = await createRelation("PB-3", "PB-1", "BLOCKED_BY");
    const [relation] = await relationsOf("PB-3");
    const deleted = await gql(app, `mutation($id: ID!) {
      issueRelationDelete(id: $id) { success }
    }`, { id: relation!.id });
    expect(deleted.data!.issueRelationDelete.success).toBe(true);
    expect(await relationsOf("PB-3")).toHaveLength(0);
    expect((await relationsOf("PB-1")).map((r) => r.relatedIssue.identifier)).toEqual(["PB-2"]);
    expect(extra.errors).toBeUndefined();
  });

  it("borrar una relación inexistente da NOT_FOUND", async () => {
    const result = await gql(app, `mutation { issueRelationDelete(id: "nope") { success } }`);
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("issue relations en el repo", () => {
  it("exporta blockedBy en el snapshot y el rebuild las reconstruye (round-trip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-relations-"));
    const other = mkdtempSync(join(tmpdir(), "pb-relations-rt-"));
    try {
      exportBoard(app.db, dir);
      const snapshot = readFileSync(join(dir, ".prime-board", "issues", "PB-1.md"), "utf8");
      expect(snapshot).toContain("blockedBy:");
      expect(snapshot).toContain("- PB-2");
      // El extremo bloqueante no repite la relación (se guarda una sola vez).
      const blocker = readFileSync(join(dir, ".prime-board", "issues", "PB-2.md"), "utf8");
      expect(blocker).not.toContain("blockedBy");

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const relations = fresh.query(
        `SELECT b.number AS blocker, t.number AS blocked, r.type FROM issue_relations r
         JOIN issues b ON b.id = r.issue_id JOIN issues t ON t.id = r.related_id`,
      ).all();
      expect(relations).toMatchObject([{ blocker: 2, blocked: 1, type: "blocks" }]);

      // Round-trip: exportar la DB reconstruida produce el mismo snapshot.
      exportBoard(fresh, other);
      expect(readFileSync(join(other, ".prime-board", "issues", "PB-1.md"), "utf8")).toBe(snapshot);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("validación de ciclos en relaciones de bloqueo (AT-176)", () => {
  beforeAll(async () => {
    for (const title of ["Ciclo A", "Ciclo B", "Ciclo C"]) {
      await gql(app, `mutation($t: String!) {
        issueCreate(input: { teamKey: "PB", title: $t }) { success }
      }`, { t: title });
    }
    // PB-4 bloqueado por PB-5: blocks(PB-5 → PB-4).
    await createRelation("PB-4", "PB-5", "BLOCKED_BY");
  });

  it("rechaza un ciclo directo (A bloqueado por B, B bloqueado por A)", async () => {
    const result = await createRelation("PB-5", "PB-4", "BLOCKED_BY");
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(result.errors?.[0]?.message).toContain("cycle");
    expect(result.errors?.[0]?.message).toContain("PB-4");
    expect(result.errors?.[0]?.message).toContain("PB-5");
  });

  it("rechaza un ciclo transitivo (A→B→C→A)", async () => {
    // PB-5 bloqueado por PB-6: blocks(PB-6 → PB-5). Cadena: PB-6 → PB-5 → PB-4.
    const ok = await createRelation("PB-5", "PB-6", "BLOCKED_BY");
    expect(ok.errors).toBeUndefined();
    // Cerrar el ciclo: PB-6 bloqueado por PB-4 → blocks(PB-4 → PB-6).
    const result = await createRelation("PB-6", "PB-4", "BLOCKED_BY");
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    for (const ident of ["PB-4", "PB-5", "PB-6"]) {
      expect(result.errors?.[0]?.message).toContain(ident);
    }
  });

  it("el grafo queda intacto tras el rechazo", async () => {
    expect(await relationsOf("PB-6")).toMatchObject([
      { type: "BLOCKS", relatedIssue: { identifier: "PB-5" } },
    ]);
  });
});
