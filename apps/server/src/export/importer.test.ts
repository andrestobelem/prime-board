// Tests de AT-157: la DB se reconstruye desde el repo (round-trip fiel).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "./exporter.ts";
import { preflightRetiredDocuments, rebuildFromRepo } from "./importer.ts";
import { appendEvent } from "./event-log.ts";
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

function historyEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: "worker",
    issue: "PB-1",
    payload: { from: "old", to: "new" },
    ts: "2025-01-01T00:00:00.000Z",
    type: "title_changed",
    ...overrides,
  };
}

function writeHistory(root: string, events: Record<string, unknown>[]): void {
  writeFileSync(
    join(root, ".prime-board", "log", "PB-1.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

function rebuildBaseline(db: Database, root: string): Record<string, number> {
  rebuildFromRepo(db, root);
  return db
    .query(
      "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
    )
    .get() as Record<string, number>;
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

  it("rehidrata el stream canónico cuando falta el log por Issue", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-canonical-rebuild-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      for (const file of readdirSync(join(snapshot, ".prime-board", "log"))) {
        if (file !== "events.jsonl") unlinkSync(join(snapshot, ".prime-board", "log", file));
      }
      const actor = app.db.query("SELECT name FROM actors WHERE name = 'worker'").get() as {
        name: string;
      };
      const states = app.db
        .query(
          `SELECT workflow_states.id FROM workflow_states
           JOIN teams ON teams.id = workflow_states.team_id
           WHERE teams.key = 'PB' ORDER BY workflow_states.position LIMIT 2`,
        )
        .all() as Array<{ id: string }>;
      appendEvent(
        {
          schemaVersion: 1,
          eventId: "canonical-comment-1",
          aggregate: "issue",
          aggregateKey: "PB-1",
          type: "commented",
          actor: actor.name,
          occurredAt: "2025-01-01T00:00:00.000Z",
          payload: { body: "canonical comment" },
        },
        { rootDir: snapshot },
      );
      appendEvent(
        {
          schemaVersion: 1,
          eventId: "canonical-state-1",
          aggregate: "issue",
          aggregateKey: "PB-1",
          type: "state_changed",
          actor: actor.name,
          occurredAt: "2025-01-01T00:00:01.000Z",
          payload: { from: states[0]!.id, to: states[1]!.id },
        },
        { rootDir: snapshot },
      );
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const result = rebuildFromRepo(fresh, snapshot);
      expect(result.comments).toBe(1);
      expect(result.events).toBe(2);
      expect(fresh.query("SELECT body FROM comments").get()).toEqual({
        body: "canonical comment",
      });
      const activity = fresh
        .query("SELECT type, payload FROM activity ORDER BY created_at, id")
        .all() as Array<{ type: string; payload: string }>;
      expect(activity.at(-1)?.type).toBe("state_changed");
      const payload = JSON.parse(activity.at(-1)!.payload) as { from: string; to: string };
      // Canonical Activity payloads keep source IDs. The activity table is a
      // history index, so rebuild must not reinterpret them as natural keys.
      expect(payload).toEqual({ from: states[0]!.id, to: states[1]!.id });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("no duplica el historial canónico cuando existe log por Issue", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-canonical-dedup-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      appendEvent(
        {
          schemaVersion: 1,
          eventId: "canonical-duplicate-1",
          aggregate: "issue",
          aggregateKey: "PB-1",
          type: "commented",
          actor: "worker",
          occurredAt: "2025-01-01T00:00:00.000Z",
          payload: { body: "must not be duplicated" },
        },
        { rootDir: snapshot },
      );
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const result = rebuildFromRepo(fresh, snapshot);
      expect(result.comments).toBe(1);
      expect(fresh.query("SELECT body FROM comments").get()).toEqual({ body: "hola" });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("usa el stream canónico cuando el log por Issue está vacío", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-empty-history-fallback-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      writeFileSync(join(snapshot, ".prime-board", "log", "PB-1.jsonl"), "");
      appendEvent(
        {
          schemaVersion: 1,
          eventId: "canonical-empty-log-fallback",
          aggregate: "issue",
          aggregateKey: "PB-1",
          type: "commented",
          actor: "worker",
          occurredAt: "2025-01-01T00:00:00.000Z",
          payload: { body: "recovered from canonical stream" },
        },
        { rootDir: snapshot },
      );
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);

      expect(rebuildFromRepo(fresh, snapshot).comments).toBe(1);
      expect(fresh.query("SELECT body FROM comments").get()).toEqual({
        body: "recovered from canonical stream",
      });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza un ActivityType desconocido del fallback canónico y no escribe", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-invalid-canonical-activity-type-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const before = rebuildBaseline(fresh, snapshot);
      for (const file of ["PB-1.jsonl", "PB-2.jsonl"]) {
        unlinkSync(join(snapshot, ".prime-board", "log", file));
      }
      appendEvent(
        {
          schemaVersion: 1,
          eventId: "canonical-invalid-activity-type",
          aggregate: "issue",
          aggregateKey: "PB-1",
          type: "unknown_activity",
          actor: "worker",
          occurredAt: "2025-01-01T00:00:00.000Z",
          payload: {},
        },
        { rootDir: snapshot },
      );

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/unknown ActivityType/);
      expect(
        fresh
          .query(
            "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
          )
          .get(),
      ).toEqual(before);
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza un ActivityType desconocido antes de escribir", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-invalid-activity-type-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const before = rebuildBaseline(fresh, snapshot);
      writeHistory(snapshot, [historyEvent({ type: "admin_secret" })]);

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/unknown ActivityType/);
      expect(
        fresh
          .query(
            "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
          )
          .get(),
      ).toEqual(before);
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza un evento cuyo destino no coincide con el Issue del log", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-invalid-history-target-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const before = rebuildBaseline(fresh, snapshot);
      writeHistory(snapshot, [historyEvent({ issue: "PB-2" })]);

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/expected PB-1/);
      expect(
        fresh
          .query(
            "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
          )
          .get(),
      ).toEqual(before);
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza un timestamp inválido antes de abrir la transacción", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-invalid-history-timestamp-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const before = rebuildBaseline(fresh, snapshot);
      writeHistory(snapshot, [historyEvent({ ts: "not-a-date" })]);

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/ts must be a valid ISO-8601 date/);
      expect(
        fresh
          .query(
            "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
          )
          .get(),
      ).toEqual(before);
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza timestamps de historial fuera de orden y no escribe", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-unsorted-history-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      const before = rebuildBaseline(fresh, snapshot);
      writeHistory(snapshot, [
        historyEvent({ ts: "2025-01-02T00:00:00.000Z" }),
        historyEvent({ type: "description_changed", ts: "2025-01-01T00:00:00.000Z" }),
      ]);

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/timestamps must be ordered/);
      expect(
        fresh
          .query(
            "SELECT (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM activity) AS activity",
          )
          .get(),
      ).toEqual(before);
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("rechaza documents.json sin archivo externo y no toca la DB", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-retired-documents-preflight-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      const documentsPath = join(snapshot, ".prime-board", "meta", "documents.json");
      writeFileSync(
        documentsPath,
        `${JSON.stringify([
          {
            title: "Retired runbook",
            content: "must not become an issue description",
            creator: "admin",
            target: null,
          },
        ])}\n`,
      );
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);

      expect(() => rebuildFromRepo(fresh, snapshot)).toThrow(/documents.json/);
      expect(existsSync(documentsPath)).toBe(true);
      expect(fresh.query("SELECT count(*) AS count FROM issues").get()).toEqual({ count: 0 });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("archiva y retira documents.json solo con un destino explícito", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-retired-documents-archive-"));
    const archive = join(snapshot, "..", `documents-${Date.now()}.archive.json`);
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      const documentsPath = join(snapshot, ".prime-board", "meta", "documents.json");
      writeFileSync(
        documentsPath,
        `${JSON.stringify([
          {
            title: "Retired runbook",
            content: "must not become an issue description",
            creator: "admin",
            target: null,
          },
        ])}\n`,
      );
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      preflightRetiredDocuments(snapshot, archive);
      expect(existsSync(documentsPath)).toBe(false);
      const manifest = JSON.parse(readFileSync(archive, "utf8")) as {
        count: number;
        sha256: string;
        sources: Record<string, { count: number; documents: Array<Record<string, unknown>> }>;
      };
      expect(manifest.count).toBe(1);
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.sources.replica?.documents[0]?.content).toBe(
        "must not become an issue description",
      );
      rebuildFromRepo(fresh, snapshot);
      expect(fresh.query("SELECT count(*) AS count FROM issues").get()).toEqual({ count: 2 });
      expect(
        fresh
          .query("SELECT count(*) AS count FROM issues WHERE description = ?1")
          .get("must not become an issue description"),
      ).toEqual({ count: 0 });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  });

  it("usa workspace como nombre por defecto para snapshots históricos sin nombre", () => {
    const legacy = mkdtempSync(join(tmpdir(), "pb-legacy-workspace-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, legacy);
      writeFileSync(join(legacy, ".prime-board", "meta", "workspace.json"), "{}\n");
      writeFileSync(join(legacy, ".prime-board", "meta", "export.json"), '{"scope":"workspace"}\n');

      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, legacy);

      expect(fresh.query("SELECT name, url_key FROM workspace").get()).toEqual({
        name: "workspace",
        url_key: "prime-board",
      });
    } finally {
      fresh.close();
      rmSync(legacy, { recursive: true, force: true });
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

  it("preserva API keys por id estable aunque el actor haya cambiado de nombre", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "pb-actor-rename-"));
    const fresh = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, snapshot);
      const actors = JSON.parse(
        readFileSync(join(snapshot, ".prime-board", "meta", "actors.json"), "utf8"),
      ) as Array<{ id: string; name: string; type: string }>;
      const source = actors.find((actor) => actor.name === "worker")!;
      expect(source.id).toBeString();

      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      fresh
        .query(
          "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES (?1, 'renamed-worker', 'agent', 'x', 'x')",
        )
        .run(source.id);
      fresh
        .query(
          "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ('rename-key', ?1, 'worker key', 'RENAMED_HASH', 'x')",
        )
        .run(source.id);

      expect(rebuildFromRepo(fresh, snapshot).preservedKeys).toBe(1);
      const key = fresh
        .query(
          "SELECT api_keys.hash, actors.name FROM api_keys JOIN actors ON actors.id = api_keys.actor_id",
        )
        .get() as { hash: string; name: string };
      expect(key).toEqual({ hash: "RENAMED_HASH", name: "worker" });
    } finally {
      fresh.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });

  it("falla antes de borrar si una API key no se puede re-vincular", () => {
    const fresh = new Database(":memory:", { strict: true });
    fresh.exec("PRAGMA foreign_keys = ON;");
    migrate(fresh);
    fresh
      .query(
        "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES ('unmatched', 'renamed-worker', 'agent', 'x', 'x')",
      )
      .run();
    fresh
      .query(
        "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ('unmatched-key', 'unmatched', 'worker key', 'HASH', 'x')",
      )
      .run();

    expect(() => rebuildFromRepo(fresh, dir)).toThrow(/Cannot preserve API key/);
    expect(fresh.query("SELECT count(*) AS count FROM actors").get()).toEqual({ count: 1 });
    fresh.close();
  });

  it("rechaza exports parciales antes de borrar y exige un modo explícito", () => {
    const partial = mkdtempSync(join(tmpdir(), "pb-partial-"));
    const populated = new Database(":memory:", { strict: true });
    const allowed = new Database(":memory:", { strict: true });
    try {
      exportBoard(app.db, partial, { teamKey: "PB" });

      populated.exec("PRAGMA foreign_keys = ON;");
      migrate(populated);
      rebuildFromRepo(populated, dir);
      const before = (
        populated.query("SELECT count(*) AS count FROM issues").get() as { count: number }
      ).count;
      expect(() => rebuildFromRepo(populated, partial)).toThrow(/Refusing partial export/);
      const after = (
        populated.query("SELECT count(*) AS count FROM issues").get() as { count: number }
      ).count;
      expect(after).toBe(before);

      allowed.exec("PRAGMA foreign_keys = ON;");
      migrate(allowed);
      expect(rebuildFromRepo(allowed, partial, { allowPartial: true }).issues).toBe(2);

      writeFileSync(
        join(partial, ".prime-board", "meta", "export.json"),
        '{"scope":"team:invalid!"}\n',
      );
      expect(() => rebuildFromRepo(allowed, partial, { allowPartial: true })).toThrow(
        /Invalid export scope/,
      );
    } finally {
      populated.close();
      allowed.close();
      rmSync(partial, { recursive: true, force: true });
    }
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
