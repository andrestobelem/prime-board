// Tests de AT-157: la DB se reconstruye desde el repo (round-trip fiel).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { rebuildFromRepo } from "./importer.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let dir: string;

function snapshotFiles(root: string): Record<string, string> {
  const base = join(root, ".prime-board");
  const out: Record<string, string> = {};
  for (const folder of ["meta", "issues", "log"]) {
    for (const file of readdirSync(join(base, folder))) {
      out[`${folder}/${file}`] = readFileSync(join(base, folder, file), "utf8");
    }
  }
  return out;
}

beforeAll(async () => {
  app = createTestApp();
  dir = mkdtempSync(join(tmpdir(), "pb-rebuild-"));
  const team = await gql(app, `{ team(key: "PB") { id states { id type } } }`);
  const teamId = team.data!.team.id;
  const agent = await gql(
    app,
    `mutation { actorCreate(input: { name: "worker", type: AGENT }) { actor { id } } }`,
  );
  const project = await gql(
    app,
    `
    mutation($t: [ID!]) { projectCreate(input: { name: "P1", teamIds: $t }) { project { id } } }
  `,
    { t: [teamId] },
  );
  const projectId = project.data!.projectCreate.project.id;
  const milestone = await gql(
    app,
    `
    mutation($p: ID!) { milestoneCreate(input: { projectId: $p, name: "M1" }) { milestone { id } } }
  `,
    { p: projectId },
  );
  const label = await gql(app, `mutation { labelCreate(input: { name: "bug" }) { label { id } } }`);

  const parent = await gql(
    app,
    `
    mutation($p: ID!, $m: ID!, $l: [ID!], $a: ID!) {
      issueCreate(input: {
        teamKey: "PB", title: "Padre", description: "desc", priority: 1, projectId: $p,
        milestoneId: $m, labelIds: $l, assigneeId: $a
      }) { issue { id } }
    }
  `,
    {
      p: projectId,
      m: milestone.data!.milestoneCreate.milestone.id,
      l: [label.data!.labelCreate.label.id],
      a: agent.data!.actorCreate.actor.id,
    },
  );
  await gql(
    app,
    `
    mutation($parent: ID!) {
      issueCreate(input: { teamKey: "PB", title: "Hijo", parentId: $parent }) { success }
    }
  `,
    { parent: parent.data!.issueCreate.issue.id },
  );
  await gql(
    app,
    `mutation { commentCreate(input: { issueId: "PB-1", body: "hola" }) { success } }`,
  );
  const started = team.data!.team.states.find((s: any) => s.type === "STARTED").id;
  await gql(
    app,
    `mutation($s: ID!) { issueUpdate(id: "PB-1", input: { stateId: $s }) { success } }`,
    { s: started },
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  app.stop();
});

describe("rebuildFromRepo", () => {
  it("reconstruye una DB vacía desde el repo con round-trip idéntico", () => {
    exportBoard(app.db, dir);
    const original = snapshotFiles(dir);

    // DB nueva y vacía: solo el esquema.
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    const result = rebuildFromRepo(fresh, dir);
    expect(result.issues).toBe(2);
    expect(result.comments).toBe(1);
    expect(result.events).toBeGreaterThan(0);

    // Exportar la DB reconstruida produce exactamente los mismos archivos.
    const other = mkdtempSync(join(tmpdir(), "pb-roundtrip-"));
    try {
      exportBoard(fresh, other);
      expect(snapshotFiles(other)).toEqual(original);
    } finally {
      rmSync(other, { recursive: true, force: true });
      fresh.close();
    }
  });

  it("acepta milestones cualificados por proyecto en snapshots importados", () => {
    const qualified = mkdtempSync(join(tmpdir(), "pb-qualified-milestone-"));
    try {
      exportBoard(app.db, qualified);
      const issuePath = join(qualified, ".prime-board", "issues", "PB-1.md");
      writeFileSync(
        issuePath,
        readFileSync(issuePath, "utf8").replace("milestone: M1", "milestone: P1/M1"),
      );

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, qualified);

      const milestone = fresh
        .query(
          "SELECT m.name FROM issues i JOIN milestones m ON m.id = i.milestone_id WHERE i.title = 'Padre'",
        )
        .get() as { name: string };
      expect(milestone.name).toBe("M1");
      fresh.close();
    } finally {
      rmSync(qualified, { recursive: true, force: true });
    }
  });

  it("reconstruye también una DB ya poblada con foreign keys activadas", () => {
    const populated = new Database(":memory:", { strict: true });
    populated.exec("PRAGMA foreign_keys = ON;");
    migrate(populated);
    rebuildFromRepo(populated, dir);

    expect(() => rebuildFromRepo(populated, dir)).not.toThrow();
    populated.close();
  });

  it("preserva relaciones: parent, milestone, labels, comentarios y assignee", () => {
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    rebuildFromRepo(fresh, dir);

    const child = fresh
      .query(
        `SELECT i.title, p.number AS parent_number FROM issues i
       JOIN issues p ON p.id = i.parent_id WHERE i.title = 'Hijo'`,
      )
      .get() as { title: string; parent_number: number };
    expect(child.parent_number).toBe(1);

    const parent = fresh
      .query(
        `SELECT i.title, a.name AS assignee, m.name AS milestone, pr.name AS project,
              (SELECT count(*) FROM comments WHERE issue_id = i.id) AS comments,
              (SELECT count(*) FROM issue_labels WHERE issue_id = i.id) AS labels
       FROM issues i
       LEFT JOIN actors a ON a.id = i.assignee_id
       LEFT JOIN milestones m ON m.id = i.milestone_id
       LEFT JOIN projects pr ON pr.id = i.project_id
       WHERE i.title = 'Padre'`,
      )
      .get() as Record<string, unknown>;
    expect(parent).toMatchObject({
      assignee: "worker",
      milestone: "M1",
      project: "P1",
      comments: 1,
      labels: 1,
    });
    fresh.close();
  });

  it("deriva next_issue_number y preserva las API keys por nombre de actor", () => {
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    // Simula credenciales locales previas al rebuild.
    const actorId = "actor-x";
    fresh
      .query(
        "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES (?1, 'admin', 'human', 'x', 'x')",
      )
      .run(actorId);
    fresh
      .query(
        "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ('k1', ?1, 'mi key', 'HASH123', 'x')",
      )
      .run(actorId);

    const result = rebuildFromRepo(fresh, dir);
    expect(result.preservedKeys).toBe(1);
    const key = fresh
      .query(
        "SELECT api_keys.hash, actors.name FROM api_keys JOIN actors ON actors.id = api_keys.actor_id",
      )
      .get() as { hash: string; name: string };
    expect(key).toEqual({ hash: "HASH123", name: "admin" });

    const team = fresh.query("SELECT next_issue_number FROM teams WHERE key = 'PB'").get() as {
      next_issue_number: number;
    };
    expect(team.next_issue_number).toBe(3);
    fresh.close();
  });

  it("falla claramente si no hay .prime-board", () => {
    const empty = mkdtempSync(join(tmpdir(), "pb-empty-"));
    try {
      const fresh = new Database(":memory:", { strict: true });
      migrate(fresh);
      expect(() => rebuildFromRepo(fresh, empty)).toThrow(/No .prime-board/);
      fresh.close();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
