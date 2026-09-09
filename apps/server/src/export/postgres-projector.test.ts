import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Persistence,
  PersistenceTransaction,
  PersistenceResult,
  SqlValue,
} from "../db/persistence.ts";
import { EventLogWriter, type DomainEvent, type JsonObject } from "./event-log.ts";
import { activityToDomainEvent } from "./activity-stream.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import {
  canonicalEventFromMutation,
  canonicalEventFromWebhook,
  PostgresRepoSync,
} from "./postgres-repo-sync.ts";
import { applyCanonicalEvent } from "./postgres-projector.ts";

const actor = { id: "actor-1", name: "Agent", type: "agent" };
const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;
const base = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  schemaVersion: 1,
  eventId: "event-1",
  aggregate: "issue",
  aggregateKey: "PB-1",
  type: "issue.created",
  actor,
  workspaceId: "workspace-1",
  occurredAt: "2025-01-01T00:00:00.000Z",
  payload: {
    id: "issue_uuid_1",
    identifier: "PB-1",
    title: "Issue",
    teamId: "team-1",
    team: "PB",
    number: 1,
    stateId: "state-1",
    creatorId: "actor-1",
    priority: 1,
    description: null,
    assigneeId: null,
    parentId: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    sortOrder: 2,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    archivedAt: null,
  },
  ...overrides,
});

function transactionLog() {
  const calls: string[] = [];
  const tx: PersistenceTransaction = {
    one: async <Row extends object = Record<string, unknown>>(sql: string): Promise<Row | null> => {
      calls.push(`one:${sql}`);
      return null;
    },
    many: async <Row extends object = Record<string, unknown>>(
      sql: string,
    ): Promise<readonly Row[]> => {
      calls.push(`many:${sql}`);
      return [];
    },
    execute: async <Row extends object = Record<string, unknown>>(
      sql: string,
      _params?: readonly (string | bigint | Uint8Array | number | boolean | null)[],
    ): Promise<PersistenceResult<Row>> => {
      calls.push(`execute:${sql}`);
      return { rows: [], rowCount: 1 };
    },
  };
  const persistence: Persistence = {
    ...tx,
    transaction: async <Result>(callback: (current: PersistenceTransaction) => Promise<Result>) => {
      calls.push("transaction:start");
      const result = await callback(tx);
      calls.push("transaction:commit");
      return result;
    },
    close: async () => undefined,
  };
  return { calls, persistence };
}

function relationPersistence() {
  const calls: Array<{ sql: string; params: readonly SqlValue[] }> = [];
  const tx: PersistenceTransaction = {
    one: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<Row | null> => {
      const values = params ?? [];
      if (sql.includes("SELECT id FROM issues WHERE id = $1")) {
        const id = values[0];
        if (id === "issue-one" || id === "issue-two") return { id } as Row;
      }
      if (sql.includes("SELECT issues.id FROM issues JOIN teams")) {
        const key =
          values[0] === "PB" && (values[1] === 1 || values[2] === 1)
            ? "issue-one"
            : values[0] === "PB" && (values[1] === 2 || values[2] === 2)
              ? "issue-two"
              : null;
        return key ? ({ id: key } as Row) : null;
      }
      if (sql.includes("SELECT id FROM actors WHERE id = $1")) return { id: values[0] } as Row;
      return null;
    },
    many: async <Row extends object = Record<string, unknown>>(): Promise<readonly Row[]> => [],
    execute: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<PersistenceResult<Row>> => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    },
  };
  const persistence: Persistence = {
    ...tx,
    transaction: async <Result>(callback: (current: PersistenceTransaction) => Promise<Result>) =>
      callback(tx),
    close: async () => undefined,
  };
  return { calls, persistence };
}

function sqliteProjectionPersistence() {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspace (id TEXT PRIMARY KEY);
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, workspace_role TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE UNIQUE INDEX actors_name_lower_idx ON actors (lower(name));
    CREATE TABLE teams (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, next_issue_number INTEGER, default_state_id TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, visibility TEXT, access_policy TEXT);
    CREATE TABLE workflow_states (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT, color TEXT, position REAL, created_at TEXT, updated_at TEXT, FOREIGN KEY (team_id) REFERENCES teams(id));
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE milestones (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, position REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE cycles (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, number INTEGER, name TEXT, starts_at TEXT, ends_at TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE issues (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, state_id TEXT NOT NULL, priority INTEGER, assignee_id TEXT, parent_id TEXT, project_id TEXT, creator_id TEXT NOT NULL, sort_order REAL, created_at TEXT, updated_at TEXT, archived_at TEXT, milestone_id TEXT, cycle_id TEXT, UNIQUE(team_id, number), FOREIGN KEY (team_id) REFERENCES teams(id), FOREIGN KEY (state_id) REFERENCES workflow_states(id), FOREIGN KEY (creator_id) REFERENCES actors(id));
    CREATE TABLE issue_subscribers (issue_id TEXT NOT NULL, actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY (issue_id, actor_id));
    CREATE TABLE issue_labels (issue_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (issue_id, label_id));
    CREATE TABLE issue_relations (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, related_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT, UNIQUE(issue_id, related_id, type));
    CREATE TABLE reviews (id TEXT PRIMARY KEY, issue_id TEXT, requester_id TEXT, reviewer_id TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE comments (id TEXT PRIMARY KEY, issue_id TEXT, actor_id TEXT, body TEXT, created_at TEXT, edited_at TEXT);
    CREATE TABLE activity (id TEXT PRIMARY KEY, issue_id TEXT, actor_id TEXT, type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT, color TEXT, team_id TEXT, created_at TEXT);
    CREATE TABLE project_teams (project_id TEXT, team_id TEXT);
    CREATE TABLE team_memberships (team_id TEXT, actor_id TEXT);
    CREATE TABLE saved_views (id TEXT PRIMARY KEY, team_id TEXT);
    CREATE TABLE webhooks (id TEXT PRIMARY KEY, team_id TEXT);
    CREATE TABLE initiative_teams (initiative_id TEXT, team_id TEXT);
    CREATE TABLE api_key_team_limits (api_key_id TEXT, team_id TEXT);
  `);
  const tx: PersistenceTransaction = {
    one: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ) => (db.query(sql).get(...(params ?? [])) as Row | null) ?? null,
    many: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ) => db.query(sql).all(...(params ?? [])) as Row[],
    execute: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ) => {
      const result = db.query(sql).run(...(params ?? []));
      return { rows: [], rowCount: result.changes } as PersistenceResult<Row>;
    },
  };
  const persistence: Persistence = {
    ...tx,
    transaction: async <Result>(callback: (current: PersistenceTransaction) => Promise<Result>) =>
      callback(tx),
    close: async () => db.close(),
  };
  return { db, persistence };
}

describe("canonical PostgreSQL projection", () => {
  it("normalizes relation views from both endpoints and removes the canonical row", async () => {
    const fake = relationPersistence();
    const relationEvent = (
      eventId: string,
      aggregateKey: string,
      issueId: string,
      eventType: string,
      relationType: string,
      issue: string,
    ): DomainEvent => ({
      schemaVersion: 1,
      eventId,
      aggregate: "issue",
      aggregateKey,
      type: eventType,
      actor,
      workspaceId: "workspace-1",
      occurredAt: "2025-01-01T00:00:00.000Z",
      payload: { issueId, type: relationType, issue },
    });
    await applyCanonicalEvent(
      fake.persistence,
      relationEvent("relation-a", "PB-1", "issue-one", "relation_added", "blocks", "PB-2"),
    );
    await applyCanonicalEvent(
      fake.persistence,
      relationEvent("relation-b", "PB-2", "issue-two", "relation_added", "blocked_by", "PB-1"),
    );
    const inserts = fake.calls.filter((call) => call.sql.includes("INSERT INTO issue_relations"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params.slice(1, 4)).toEqual(["issue-one", "issue-two", "blocks"]);
    expect(inserts[1]?.params.slice(1, 4)).toEqual(["issue-one", "issue-two", "blocks"]);

    await applyCanonicalEvent(
      fake.persistence,
      relationEvent("remove-a", "PB-1", "issue-one", "relation_removed", "blocks", "PB-2"),
    );
    await applyCanonicalEvent(
      fake.persistence,
      relationEvent("remove-b", "PB-2", "issue-two", "relation_removed", "blocked_by", "PB-1"),
    );
    const deletes = fake.calls.filter((call) => call.sql.includes("DELETE FROM issue_relations"));
    expect(deletes.map((call) => call.params)).toEqual([
      ["issue-one", "issue-two", "blocks"],
      ["issue-one", "issue-two", "blocks"],
    ]);

    const snapshots = relationPersistence();
    const snapshot = (
      id: string,
      issueId: string,
      relatedId: string,
      type: string,
    ): DomainEvent => ({
      schemaVersion: 1,
      eventId: id,
      aggregate: "issue_relation",
      aggregateKey: id,
      type: "snapshot_imported",
      actor,
      workspaceId: "workspace-1",
      occurredAt: "2025-01-01T00:00:00.000Z",
      payload: { id, issueId, relatedId, type },
    });
    await applyCanonicalEvent(
      snapshots.persistence,
      snapshot("snapshot-blocked", "issue-one", "issue-two", "blocked_by"),
    );
    await applyCanonicalEvent(
      snapshots.persistence,
      snapshot("snapshot-related", "issue-two", "issue-one", "related"),
    );
    const snapshotInserts = snapshots.calls.filter((call) =>
      call.sql.includes("INSERT INTO issue_relations"),
    );
    expect(snapshotInserts[0]?.params.slice(1, 4)).toEqual(["issue-two", "issue-one", "blocks"]);
    expect(snapshotInserts[1]?.params.slice(1, 4)).toEqual(["issue-one", "issue-two", "related"]);
    await expect(
      applyCanonicalEvent(
        snapshots.persistence,
        snapshot("snapshot-self", "issue-one", "issue-one", "blocks"),
      ),
    ).rejects.toThrow("cannot connect an Issue to itself");
  });

  it("promotes a natural Issue row to the canonical UUID and rebinds its history", async () => {
    const fake = sqliteProjectionPersistence();
    const markdown: DomainEvent = {
      schemaVersion: 1,
      eventId: "markdown-created",
      aggregate: "issue",
      aggregateKey: "PB-1",
      type: "created",
      actor: { id: "importer", name: "Importer", type: "agent" },
      workspaceId: "workspace-1",
      occurredAt: "2025-01-01T00:00:00.000Z",
      payload: {
        identifier: "PB-1",
        title: "Markdown issue",
        teamId: "team:PB",
        team: "PB",
        number: 1,
        stateId: "state:team:PB:Todo",
        state: "Todo",
        creator: "Alice",
        priority: 0,
        description: null,
        assignee: null,
        parent: null,
        project: null,
        milestone: null,
        cycle: null,
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        archivedAt: null,
      },
    };
    const canonical = base({
      eventId: "canonical-created",
      type: "issue.created",
      actor: { id: "actor-uuid", name: "Canonical agent", type: "human" },
      payload: {
        ...base().payload,
        id: "issue-uuid",
        title: "Canonical issue",
        teamId: "team-uuid",
        stateId: "state-uuid",
        creatorId: "actor-uuid",
        updatedAt: "2025-01-01T00:00:01.000Z",
      },
    });
    await applyCanonicalEvent(fake.persistence, markdown);
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "partial-updated",
        type: "issue.updated",
        payload: {
          id: "issue-uuid",
          identifier: "PB-1",
          title: "Updated before snapshot",
          changes: { title: { from: "Markdown issue", to: "Updated before snapshot" } },
          updatedAt: "2025-01-01T00:00:00.500Z",
        },
      }),
    );
    expect(fake.db.query("SELECT id, title FROM issues").all()).toEqual([
      { id: "issue:workspace-1:PB-1", title: "Updated before snapshot" },
    ]);
    fake.db
      .query(
        "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES ($1, $2, 'human', $3, $3)",
      )
      .run("actor-uuid", "Canonical agent", "2025-01-01T00:00:00.000Z");
    fake.db
      .query(
        "INSERT INTO teams (id, key, name, next_issue_number, created_at, updated_at) VALUES ($1, $2, $2, 2, $3, $3)",
      )
      .run("team-uuid", "OTHER", "2025-01-01T00:00:00.000Z");
    fake.db
      .query(
        "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES ($1, $2, 'Todo', 'unstarted', '#000000', 0, $3, $3)",
      )
      .run("state-uuid", "team-uuid", "2025-01-01T00:00:00.000Z");
    fake.db
      .query(
        `INSERT INTO issues
           (id, team_id, number, title, state_id, priority, creator_id, sort_order, created_at, updated_at)
         VALUES ($1, $2, 1, 'Existing canonical', $3, 0, $4, 0, $5, $5)`,
      )
      .run("issue-uuid", "team-uuid", "state-uuid", "actor-uuid", "2025-01-01T00:00:00.000Z");
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "team-snapshot",
        aggregate: "team",
        aggregateKey: "team-uuid",
        type: "team.created",
        payload: {
          id: "team-uuid",
          key: "PB",
          name: "Product",
          nextIssueNumber: 2,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:01.000Z",
        },
      }),
    );
    await applyCanonicalEvent(fake.persistence, canonical);
    const issues = fake.db.query("SELECT id, team_id, creator_id, state_id FROM issues").all();
    expect(issues).toEqual([
      {
        id: "issue-uuid",
        team_id: "team-uuid",
        creator_id: "actor-uuid",
        state_id: "state-uuid",
      },
    ]);
    expect(fake.db.query("SELECT issue_id FROM activity ORDER BY id").all()).toEqual([
      { issue_id: "issue-uuid" },
      { issue_id: "issue-uuid" },
      { issue_id: "issue-uuid" },
    ]);
    expect(fake.db.query("SELECT id FROM teams ORDER BY id").all()).toEqual([{ id: "team-uuid" }]);
    expect(fake.db.query("SELECT id FROM workflow_states ORDER BY id").all()).toEqual([
      { id: "state-uuid" },
    ]);
    await fake.persistence.close();
  });

  it("rebindea el Team antes de resolver un State sintético en un Issue canónico", async () => {
    const fake = sqliteProjectionPersistence();
    const legacyPayload = { ...base().payload };
    delete legacyPayload.id;
    const legacy = base({
      eventId: "legacy-team-state",
      type: "created",
      aggregateKey: "PB-1",
      payload: {
        ...legacyPayload,
        teamId: "team:PB",
        stateId: "state:team:PB:Todo",
        state: "Todo",
        creatorId: "actor-1",
      },
    });
    await applyCanonicalEvent(fake.persistence, legacy);
    fake.db
      .query(
        "UPDATE teams SET key = 'historical:team:PB', name = 'historical:team:PB' WHERE id = 'team:PB'",
      )
      .run();
    fake.db
      .query(
        "INSERT INTO teams (id, key, name, next_issue_number, default_state_id, created_at, updated_at) VALUES ($1, $2, $2, $3, $4, $5, $5)",
      )
      .run("team-canonical", "PB", 41, "state-canonical", "2025-01-01T00:00:00.000Z");
    fake.db
      .query(
        "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at) VALUES ($1, $2, 'Todo', 'unstarted', '#000000', 0, $3, $3)",
      )
      .run("state-canonical", "team-canonical", "2025-01-01T00:00:00.000Z");
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "canonical-team-state",
        type: "issue.created",
        payload: {
          ...base().payload,
          id: "issue-canonical",
          teamId: "team-canonical",
          stateId: "state:team:PB:Todo",
          state: "Todo",
          updatedAt: "2025-01-01T00:00:01.000Z",
        },
      }),
    );
    expect(fake.db.query("SELECT id, team_id, state_id FROM issues").all()).toEqual([
      { id: "issue-canonical", team_id: "team-canonical", state_id: "state-canonical" },
    ]);
    expect(fake.db.query("SELECT id FROM workflow_states ORDER BY id").all()).toEqual([
      { id: "state-canonical" },
    ]);
    expect(
      fake.db
        .query("SELECT default_state_id, next_issue_number FROM teams WHERE id = 'team-canonical'")
        .get(),
    ).toEqual({ default_state_id: "state-canonical", next_issue_number: 41 });
    await fake.persistence.close();
  });

  it("keeps sparse Activity updates on the placeholder until a full snapshot arrives", async () => {
    const fake = sqliteProjectionPersistence();
    fake.db
      .query(
        "INSERT INTO teams (id, key, name, next_issue_number, created_at, updated_at) VALUES ($1, $2, $2, 1, $3, $3)",
      )
      .run("team-uuid", "PB", "2025-01-01T00:00:00.000Z");
    const sparse: DomainEvent = {
      schemaVersion: 1,
      eventId: "sparse-created",
      aggregate: "issue",
      aggregateKey: "pb-1",
      type: "created",
      actor: { id: "actor:Importer", name: "Importer", type: "agent" },
      workspaceId: "workspace-1",
      occurredAt: "2025-01-01T00:00:00.000Z",
      payload: { title: "Sparse Activity" },
    };
    await applyCanonicalEvent(fake.persistence, sparse);
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "sparse-archived",
        type: "issue.archived",
        payload: {
          id: "issue-uuid",
          identifier: "PB-1",
          archivedAt: "2025-01-01T00:00:00.250Z",
        },
      }),
    );
    expect(fake.db.query("SELECT archived_at FROM issues").all()).toEqual([
      { archived_at: "2025-01-01T00:00:00.250Z" },
    ]);
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "sparse-unarchived",
        type: "issue.unarchived",
        payload: { id: "issue-uuid", identifier: "PB-1", archivedAt: null },
      }),
    );
    expect(fake.db.query("SELECT archived_at FROM issues").all()).toEqual([{ archived_at: null }]);
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "sparse-update",
        type: "issue.updated",
        payload: {
          id: "issue-uuid",
          identifier: "PB-1",
          title: "Updated Activity",
          changes: { title: { from: "Sparse Activity", to: "Updated Activity" } },
        },
      }),
    );
    expect(fake.db.query("SELECT id, title FROM issues").all()).toEqual([
      { id: "historical-issue:workspace-1:PB-1", title: "Updated Activity" },
    ]);
    await applyCanonicalEvent(
      fake.persistence,
      base({
        eventId: "sparse-snapshot",
        type: "issue.created",
        actor: { id: "actor-uuid", name: "Importer", type: "human" },
        payload: {
          ...base().payload,
          id: "issue-uuid",
          title: "Canonical issue",
          teamId: "team-uuid",
          stateId: "state-uuid",
          creatorId: "actor-uuid",
          updatedAt: "2025-01-01T00:00:01.000Z",
        },
      }),
    );
    expect(fake.db.query("SELECT id, team_id FROM issues").all()).toEqual([
      { id: "issue-uuid", team_id: "team-uuid" },
    ]);
    await fake.persistence.close();
  });

  it("rejects embedded Workspace scopes that cross the event or database scope", async () => {
    const fake = transactionLog();
    await expect(
      applyCanonicalEvent(
        fake.persistence,
        base({
          aggregate: "workspace",
          aggregateKey: "workspace-1",
          payload: { id: "workspace-2", name: "Other" },
        }),
      ),
    ).rejects.toThrow("does not match event scope");
    await expect(
      applyCanonicalEvent(
        fake.persistence,
        base({ payload: { ...base().payload, workspaceId: "workspace-2" } }),
      ),
    ).rejects.toThrow("does not match event scope");
    const scoped = sqliteProjectionPersistence();
    scoped.db.query("INSERT INTO workspace (id) VALUES ($1)").run("workspace-1");
    await expect(
      applyCanonicalEvent(scoped.persistence, base({ workspaceId: "workspace-2" })),
    ).rejects.toThrow("does not match PostgreSQL Workspace");
    await scoped.persistence.close();
  });

  it("projects a complete Issue event without reading an operational Issue row", async () => {
    const fake = transactionLog();
    await applyCanonicalEvent(fake.persistence, base());
    const issueInsert = fake.calls.find((call) => call.includes("INSERT INTO issues"));
    expect(issueInsert).toBeDefined();
    expect(fake.calls.some((call) => call.includes("INSERT INTO actors"))).toBe(true);
    expect(fake.calls.some((call) => call.includes("INSERT INTO teams"))).toBe(true);
    expect(fake.calls.some((call) => call.includes("INSERT INTO workflow_states"))).toBe(true);
  });

  it("preserves explicit nulls when a replay clears Issue references", async () => {
    const fake = transactionLog();
    const existing = {
      id: "issue_uuid_1",
      team_id: "team-1",
      number: 1,
      title: "Issue",
      description: "body",
      state_id: "state-1",
      priority: 1,
      assignee_id: "actor-2",
      parent_id: "parent-1",
      project_id: "project-1",
      creator_id: "actor-1",
      sort_order: 2,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      archived_at: null,
      milestone_id: "milestone-1",
      cycle_id: "cycle-1",
    };
    const withExisting: Persistence = {
      ...fake.persistence,
      one: async <Row extends object = Record<string, unknown>>(sql: string) =>
        sql.includes("SELECT * FROM issues") ? (existing as unknown as Row) : null,
    };
    await applyCanonicalEvent(
      withExisting,
      base({
        eventId: "event-2",
        type: "issue.updated",
        payload: {
          id: "issue_uuid_1",
          identifier: "PB-1",
          assigneeId: null,
          parentId: null,
          projectId: null,
          milestoneId: null,
          cycleId: null,
          changes: {},
        },
      }),
    );
    const update = fake.calls.find((call) => call.includes("UPDATE issues SET"));
    expect(update).toBeDefined();
  });

  it("separates project updates from project aggregate events", () => {
    const event = canonicalEventFromWebhook({
      workspaceId: "workspace-1",
      event: "project.updated",
      actor,
      data: {
        id: "project-1",
        updateId: "update-1",
        health: "at_risk",
        body: "Risk",
        authorId: "actor-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    expect(event.aggregate).toBe("project_update");
    expect(event.type).toBe("project_update.created");
    expect(event.payload.id).toBe("update-1");
    expect(event.payload.projectId).toBe("project-1");
  });

  it("does not include private mapper fields in mutation events", () => {
    const event = canonicalEventFromMutation({
      workspaceId: "workspace-1",
      actor,
      name: "projectUpdate",
      args: { id: "project-1", input: { name: "Renamed" } },
      result: {
        success: true,
        project: { id: "project-1", name: "Renamed", _row: { secret: "x" } },
      },
    });
    expect(event?.payload._row).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("replays snapshot_imported parent and relation rows without fake Activity", async () => {
    const fake = transactionLog();
    const timestamp = "2025-01-01T00:00:00.000Z";
    const makeSnapshot = (
      aggregate: string,
      aggregateKey: string,
      payload: JsonObject,
    ): DomainEvent => ({
      schemaVersion: 1,
      eventId: `sqlite:${aggregate}:${aggregateKey}`,
      aggregate,
      aggregateKey,
      type: "snapshot_imported",
      actor: { source: "sqlite", table: aggregate },
      workspaceId: "workspace-1",
      occurredAt: timestamp,
      payload,
    });
    const snapshots: DomainEvent[] = [
      makeSnapshot("issue", "issue-one", {
        id: "issue-one",
        identifier: "PB-1",
        team_id: "team-one",
        team_key: "PB",
        number: 1,
        title: "Issue",
        state_id: "state-one",
        creator_id: "actor-one",
        priority: 1,
        sort_order: 0,
        created_at: timestamp,
        updated_at: timestamp,
        description: null,
        assignee_id: null,
        parent_id: null,
        project_id: "project-one",
        milestone_id: null,
        cycle_id: null,
        archived_at: null,
      }),
      makeSnapshot("project_team", '["project-one","team-one"]', {
        project_id: "project-one",
        team_id: "team-one",
      }),
      makeSnapshot("issue_label", '["issue-one","label-one"]', {
        issue_id: "issue-one",
        label_id: "label-one",
      }),
      makeSnapshot("issue_relation", "relation-one", {
        id: "relation-one",
        issue_id: "issue-one",
        related_id: "issue-two",
        type: "blocks",
        created_at: timestamp,
      }),
      makeSnapshot("initiative_project", '["initiative-one","project-one"]', {
        initiative_id: "initiative-one",
        project_id: "project-one",
      }),
      makeSnapshot("initiative_team", '["initiative-one","team-one"]', {
        initiative_id: "initiative-one",
        team_id: "team-one",
      }),
      makeSnapshot("issue_subscriber", '["issue-one","actor-one"]', {
        issue_id: "issue-one",
        actor_id: "actor-one",
        workspace_id: "workspace-1",
        created_at: timestamp,
      }),
      makeSnapshot("workspace_membership", "membership-one", {
        id: "membership-one",
        workspace_id: "workspace-1",
        actor_id: "actor-one",
        role: "member",
        status: "active",
        created_at: timestamp,
        updated_at: timestamp,
      }),
      makeSnapshot("project_update", "update-one", {
        id: "update-one",
        project_id: "project-one",
        author_id: "actor-one",
        health: "on_track",
        body: "Good",
        risks: null,
        created_at: timestamp,
        updated_at: timestamp,
      }),
      makeSnapshot("review", "review-one", {
        id: "review-one",
        issue_id: "issue-one",
        requester_id: "actor-one",
        reviewer_id: "actor-two",
        status: "requested",
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ];
    for (const snapshot of snapshots) await applyCanonicalEvent(fake.persistence, snapshot);
    expect(fake.calls.some((call) => call.includes("INSERT INTO activity"))).toBe(false);
    expect(fake.calls.some((call) => call.includes("initiative_projects"))).toBe(true);
    expect(fake.calls.some((call) => call.includes("initiative_teams"))).toBe(true);
    expect(fake.calls.some((call) => call.includes("issue_subscribers"))).toBe(true);
    expect(fake.calls.some((call) => call.includes("workspace_memberships"))).toBe(true);
  });
});

it("fans in the exact SQLite history snapshot shape before replaying it again", async () => {
  const fake = transactionLog();
  const date = "2025-01-01T00:00:00.000Z";
  const snapshot = (
    table: string,
    aggregate: string,
    sourceId: string,
    payload: JsonObject,
    type = "snapshot_imported",
  ): DomainEvent => ({
    schemaVersion: 1,
    eventId: `sqlite:${table}:${sourceId}`,
    aggregate,
    aggregateKey: sourceId,
    type,
    actor: "a1",
    workspaceId: "w1",
    occurredAt: date,
    payload: { ...payload, source: "sqlite", sourceTable: table, sourceId },
  });
  const events: DomainEvent[] = [
    {
      schemaVersion: 1,
      eventId: "ac1",
      aggregate: "issue",
      aggregateKey: "PB-1",
      type: "created",
      actor: "a1",
      workspaceId: "w1",
      occurredAt: date,
      payload: { title: "Issue" },
    },
    snapshot("workspace", "workspace", "w1", {
      id: "w1",
      name: "Workspace",
      url_key: "workspace",
      created_at: date,
      updated_at: date,
    }),
    snapshot("actors", "actor", "a1", {
      id: "a1",
      name: "Author",
      type: "agent",
      created_at: date,
      updated_at: date,
    }),
    snapshot("workspace_memberships", "workspace_membership", "wm1", {
      id: "wm1",
      workspace_id: "w1",
      actor_id: "a1",
      role: "admin",
      status: "active",
      created_at: date,
      updated_at: date,
    }),
    snapshot("teams", "team", "t1", {
      id: "t1",
      workspace_id: "w1",
      key: "PB",
      name: "Board",
      created_at: date,
      updated_at: date,
    }),
    snapshot("workflow_states", "workflow_state", "s1", {
      id: "s1",
      workspace_id: "w1",
      team_id: "t1",
      name: "Todo",
      type: "unstarted",
      color: "#fff",
      position: 1,
      created_at: date,
      updated_at: date,
    }),
    snapshot("projects", "project", "p1", {
      id: "p1",
      workspace_id: "w1",
      name: "Project",
      state: "started",
      created_at: date,
      updated_at: date,
    }),
    snapshot("project_teams", "project_team", '["p1","t1"]', {
      project_id: "p1",
      team_id: "t1",
      workspace_id: "w1",
    }),
    snapshot("milestones", "milestone", "m1", {
      id: "m1",
      workspace_id: "w1",
      project_id: "p1",
      name: "M1",
      created_at: date,
      updated_at: date,
    }),
    snapshot("cycles", "cycle", "c1", {
      id: "c1",
      workspace_id: "w1",
      team_id: "t1",
      number: 1,
      name: "C1",
      starts_at: date,
      ends_at: date,
      state: "active",
      created_at: date,
      updated_at: date,
    }),
    snapshot("issues", "issue", "i1", {
      id: "i1",
      workspace_id: "w1",
      team_id: "t1",
      number: 1,
      title: "Issue",
      state_id: "s1",
      creator_id: "a1",
      created_at: date,
      updated_at: date,
      identifier: "PB-1",
    }),
    snapshot("issues", "issue", "i1-other", {
      id: "i1-other",
      workspace_id: "w1",
      team_id: "t1",
      number: 2,
      title: "Related issue",
      state_id: "s1",
      creator_id: "a1",
      created_at: date,
      updated_at: date,
      identifier: "PB-2",
    }),
    snapshot("labels", "label", "l1", {
      id: "l1",
      workspace_id: "w1",
      team_id: "t1",
      name: "bug",
      color: "#f00",
      created_at: date,
    }),
    snapshot("issue_labels", "issue_label", '["i1","l1"]', {
      issue_id: "i1",
      label_id: "l1",
      workspace_id: "w1",
    }),
    snapshot("issue_relations", "issue_relation", "r1", {
      id: "r1",
      workspace_id: "w1",
      issue_id: "i1",
      related_id: "i1-other",
      type: "related",
      created_at: date,
    }),
    snapshot("comments", "comment", "cm1", {
      id: "cm1",
      workspace_id: "w1",
      issue_id: "i1",
      actor_id: "a1",
      body: "Comment",
      created_at: date,
    }),
    snapshot("team_memberships", "team_membership", "tm1", {
      id: "tm1",
      workspace_id: "w1",
      team_id: "t1",
      actor_id: "a1",
      role: "owner",
      created_at: date,
    }),
    snapshot("initiatives", "initiative", "n1", {
      id: "n1",
      workspace_id: "w1",
      name: "Initiative",
      state: "active",
      created_at: date,
      updated_at: date,
    }),
    snapshot("initiative_projects", "initiative_project", '["n1","p1"]', {
      initiative_id: "n1",
      project_id: "p1",
      workspace_id: "w1",
    }),
    snapshot("initiative_teams", "initiative_team", '["n1","t1"]', {
      initiative_id: "n1",
      team_id: "t1",
      workspace_id: "w1",
    }),
    snapshot("project_updates", "project_update", "u1", {
      id: "u1",
      workspace_id: "w1",
      project_id: "p1",
      author_id: "a1",
      health: "on_track",
      body: "Update",
      risks: null,
      created_at: date,
      updated_at: date,
    }),
    snapshot("reviews", "review", "rv1", {
      id: "rv1",
      workspace_id: "w1",
      issue_id: "i1",
      requester_id: "a1",
      reviewer_id: "a1",
      status: "requested",
      created_at: date,
      updated_at: date,
    }),
    snapshot("issue_subscribers", "issue_subscriber", '["i1","a1"]', {
      issue_id: "i1",
      actor_id: "a1",
      workspace_id: "w1",
      created_at: date,
    }),
    snapshot("saved_views", "saved_view", "v1", {
      id: "v1",
      workspace_id: "w1",
      name: "Mine",
      scope: "personal",
      team_id: null,
      owner_id: "a1",
      filter_json: "{}",
      created_at: date,
      updated_at: date,
    }),
  ].sort((left, right) => left.eventId.localeCompare(right.eventId));
  for (const event of events) await applyCanonicalEvent(fake.persistence, event);
  expect(events).toHaveLength(24);
  expect(fake.calls.some((call) => call.includes("INSERT INTO activity"))).toBe(true);
  expect(fake.calls.some((call) => call.includes("project_teams"))).toBe(true);
  expect(fake.calls.some((call) => call.includes("issue_labels"))).toBe(true);
  expect(fake.calls.some((call) => call.includes("issue_relations"))).toBe(true);
  expect(fake.calls.some((call) => call.includes("initiative_projects"))).toBe(true);
  expect(fake.calls.some((call) => call.includes("issue_subscribers"))).toBe(true);
});

it("projects legacy Activity before its source Issue snapshot without fabricating Issue data", async () => {
  const executed: Array<{ sql: string; params: readonly SqlValue[] }> = [];
  const placeholder = "historical-issue:workspace-1:PB-1";
  let placeholderExists = false;
  const tx: PersistenceTransaction = {
    one: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<Row | null> => {
      if (
        sql.includes("SELECT id FROM issues") &&
        params?.[0] === placeholder &&
        placeholderExists
      ) {
        return { id: placeholder } as Row;
      }
      return null;
    },
    many: async <Row extends object = Record<string, unknown>>(): Promise<readonly Row[]> => [],
    execute: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<PersistenceResult<Row>> => {
      const values = params ?? [];
      executed.push({ sql, params: values });
      if (sql.includes("INSERT INTO issues") && values[0] === placeholder) placeholderExists = true;
      return { rows: [], rowCount: 1 };
    },
  };
  const event = (eventId: string, type: string, payload: JsonObject): DomainEvent => ({
    schemaVersion: 1,
    eventId,
    aggregate: "issue",
    aggregateKey: "PB-1",
    type,
    actor: "a1",
    workspaceId: "workspace-1",
    occurredAt: "2025-01-01T00:00:00.000Z",
    payload,
  });
  await applyCanonicalEvent(tx, event("ac1", "created", { title: "Issue" }));
  await applyCanonicalEvent(tx, event("ac2", "title_changed", { from: "Old", to: "Issue" }));
  await applyCanonicalEvent(
    tx,
    event("sqlite:issues:i1", "snapshot_imported", {
      id: "i1",
      identifier: "PB-1",
      team_id: "t1",
      team_key: "PB",
      number: 1,
      title: "Issue",
      state_id: "s1",
      creator_id: "a1",
      priority: 0,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    }),
  );
  const issueInserts = executed.filter((entry) => entry.sql.includes("INSERT INTO issues"));
  expect(issueInserts[0]?.params[0]).toBe(placeholder);
  expect(issueInserts[1]?.params[0]).toBe("i1");
  expect(executed.some((entry) => entry.sql.includes("UPDATE activity SET issue_id"))).toBe(true);
  expect(
    executed.some(
      (entry) => entry.sql.includes("INSERT INTO activity") && entry.params[0] === "ac1",
    ),
  ).toBe(true);
});

it("mantiene canónico un issue.created completo que también lleva issueId", async () => {
  const fake = sqliteProjectionPersistence();
  const event = base({
    eventId: "canonical-created-with-issue-id",
    payload: { ...base().payload, issueId: "issue_uuid_1" },
  });
  expect(event.payload.__source).toBeUndefined();
  await applyCanonicalEvent(fake.persistence, event);
  expect(fake.db.query("SELECT id, title FROM issues").all()).toEqual([
    { id: "issue_uuid_1", title: "Issue" },
  ]);
  await fake.persistence.close();
});

it("conserva Activity legacy enriquecida con issueId en PostgreSQL vacío", async () => {
  const fake = sqliteProjectionPersistence();
  const occurredAt = {
    updated: "2025-01-01T00:00:01.000Z",
    title_changed: "2025-01-01T00:00:02.000Z",
  } as const;
  for (const type of ["updated", "title_changed"] as const) {
    const event = activityToDomainEvent({
      id: `activity-${type}`,
      issue_identifier: "PB-1",
      issue_id: "issue-uuid",
      actor_id: "actor-1",
      actor: "Agent",
      type,
      payload: JSON.stringify({ title: "Changed" }),
      workspace_id: "workspace-1",
      occurred_at: occurredAt[type],
    });
    expect(event).toBeDefined();
    expect(event?.payload.__source).toBe("activity");
    await applyCanonicalEvent(fake.persistence, event!);
  }
  const activity = fake.db
    .query("SELECT id, issue_id, actor_id, type, payload, created_at FROM activity ORDER BY id")
    .all() as Array<Record<string, string>>;
  expect(activity).toEqual([
    {
      id: "activity-title_changed",
      issue_id: "issue-uuid",
      actor_id: "actor-1",
      type: "title_changed",
      payload: JSON.stringify({ title: "Changed", issueId: "issue-uuid" }),
      created_at: occurredAt.title_changed,
    },
    {
      id: "activity-updated",
      issue_id: "issue-uuid",
      actor_id: "actor-1",
      type: "updated",
      payload: JSON.stringify({ title: "Changed", issueId: "issue-uuid" }),
      created_at: occurredAt.updated,
    },
  ]);
  expect(fake.db.query("SELECT id, title FROM issues").all()).toEqual([
    { id: "issue-uuid", title: "issue-uuid" },
  ]);
  await fake.persistence.close();
});

it("reemplaza el contenido del placeholder Activity con el snapshot canónico completo", async () => {
  const fake = sqliteProjectionPersistence();
  const legacyActivity: DomainEvent = {
    schemaVersion: 1,
    eventId: "activity-created",
    aggregate: "issue",
    aggregateKey: "PB-1",
    type: "created",
    actor,
    workspaceId: "workspace-1",
    occurredAt: "2025-01-01T00:00:01.000Z",
    payload: { __source: "activity", title: "Issue" },
  };
  const canonical = base({
    eventId: "issue-created",
    occurredAt: "2025-01-01T00:00:02.000Z",
    payload: {
      ...base().payload,
      id: "issue-canonical",
      title: "Issue",
      number: 1,
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  });
  await applyCanonicalEvent(fake.persistence, legacyActivity);
  await applyCanonicalEvent(fake.persistence, canonical);

  expect(
    fake.db
      .query("SELECT id, team_id, number, title, state_id, creator_id, sort_order FROM issues")
      .all(),
  ).toEqual([
    {
      id: "issue-canonical",
      team_id: "team-1",
      number: 1,
      title: "Issue",
      state_id: "state-1",
      creator_id: "actor-1",
      sort_order: 2,
    },
  ]);
  expect(fake.db.query("SELECT issue_id, type FROM activity ORDER BY id").all()).toEqual([
    { issue_id: "issue-canonical", type: "created" },
    { issue_id: "issue-canonical", type: "issue.created" },
  ]);
  expect(fake.db.query("SELECT id FROM teams ORDER BY id").all()).toEqual([{ id: "team-1" }]);
  expect(fake.db.query("SELECT id FROM workflow_states ORDER BY id").all()).toEqual([
    { id: "state-1" },
  ]);
  await fake.persistence.close();
});

integration("reproduce Activity-before-snapshot promotion on PostgreSQL constraints", async () => {
  const harness = await createPostgresHarness({
    url: process.env.PRIME_BOARD_POSTGRES_URL!,
    schemaPrefix: "prb599_activity_replay",
  });
  const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
    close: false,
  });
  try {
    const workspace = base({
      eventId: "workspace-created",
      aggregate: "workspace",
      aggregateKey: "workspace-1",
      type: "workspace.created",
      payload: { id: "workspace-1", name: "Workspace", urlKey: "workspace" },
    });
    const legacyActivity: DomainEvent = {
      schemaVersion: 1,
      eventId: "activity-created",
      aggregate: "issue",
      aggregateKey: "PB-1",
      type: "created",
      actor,
      workspaceId: "workspace-1",
      occurredAt: "2025-01-01T00:00:01.000Z",
      payload: { __source: "activity", title: "Issue" },
    };
    const canonical = base({
      eventId: "issue-created",
      occurredAt: "2025-01-01T00:00:02.000Z",
      payload: {
        ...base().payload,
        id: "issue-canonical",
        title: "Issue",
        teamId: "team-canonical",
        team: "PB",
        stateId: "state-canonical",
        creatorId: actor.id,
        number: 1,
        sortOrder: 2,
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    await persistence.transaction((tx) => applyCanonicalEvent(tx, workspace));
    await persistence.transaction((tx) => applyCanonicalEvent(tx, legacyActivity));
    await persistence.transaction((tx) => applyCanonicalEvent(tx, canonical));

    expect(
      await persistence.many(
        "SELECT id, team_id, number, title, state_id, creator_id, sort_order FROM issues",
      ),
    ).toEqual([
      {
        id: "issue-canonical",
        team_id: "team-canonical",
        number: 1,
        title: "Issue",
        state_id: "state-canonical",
        creator_id: actor.id,
        sort_order: 2,
      },
    ]);
    expect(await persistence.many("SELECT issue_id, type FROM activity ORDER BY id")).toEqual([
      { issue_id: "issue-canonical", type: "created" },
      { issue_id: "issue-canonical", type: "issue.created" },
    ]);
    expect(await persistence.many("SELECT id FROM teams ORDER BY id")).toEqual([
      { id: "team-canonical" },
    ]);
    expect(await persistence.many("SELECT id FROM workflow_states ORDER BY id")).toEqual([
      { id: "state-canonical" },
    ]);
  } finally {
    await persistence.close();
    await harness.close();
  }
});

describe("PostgresRepoSync", () => {
  it("commits pending events before replaying and exposes a retry-visible failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "postgres-repo-sync-"));
    const writer = new EventLogWriter({ rootDir: root });
    const fake = transactionLog();
    const order: string[] = [];
    const sync = new PostgresRepoSync({
      rootDir: root,
      persistence: fake.persistence,
      eventLog: writer,
      commitGit: () => order.push("git"),
      projector: { apply: () => order.push("project") },
      regenerate: false,
    });
    sync.recordEvent(base());
    await sync.sync();
    expect(order).toEqual(["git", "project"]);
    expect(sync.getStatus().result).toMatchObject({ status: "completed", applied: 1, lag: 0 });
  });

  it("loads the durable checkpoint and does not replay a committed event twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "postgres-replay-idempotent-"));
    const writer = new EventLogWriter({ rootDir: root });
    writer.append(base());
    let checkpoint: {
      stream: string;
      event_id: string;
      occurred_at: string;
      processed: boolean;
    } | null = null;
    const applied: string[] = [];
    const tx: PersistenceTransaction = {
      one: async <Row extends object = Record<string, unknown>>(
        sql: string,
      ): Promise<Row | null> => (sql.includes("issues") ? null : null),
      many: async <Row extends object = Record<string, unknown>>(): Promise<readonly Row[]> => [],
      execute: async <Row extends object = Record<string, unknown>>(
        sql: string,
        params?: readonly SqlValue[],
      ): Promise<PersistenceResult<Row>> => {
        if (sql.includes("projector_checkpoints") && params) {
          checkpoint = {
            stream: String(params[0]),
            event_id: String(params[1]),
            occurred_at: String(params[2]),
            processed: true,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const persistence: Persistence = {
      one: async <Row extends object = Record<string, unknown>>(
        sql: string,
      ): Promise<Row | null> => {
        if (!sql.includes("projector_checkpoints") || !checkpoint) return null;
        return {
          stream: checkpoint.stream,
          event_id: checkpoint.event_id,
          occurred_at: checkpoint.occurred_at,
          processed: checkpoint.processed,
        } as Row;
      },
      many: async <Row extends object = Record<string, unknown>>(): Promise<readonly Row[]> => [],
      execute: tx.execute,
      transaction: async <Result>(callback: (current: PersistenceTransaction) => Promise<Result>) =>
        callback(tx),
      close: async () => undefined,
    };
    const sync = new PostgresRepoSync({
      rootDir: root,
      persistence,
      eventLog: writer,
      commitGit: () => undefined,
      projector: { apply: (event) => applied.push(event.eventId) },
      regenerate: false,
    });
    await sync.sync();
    await sync.sync();
    expect(applied).toEqual(["event-1"]);
    expect(sync.getStatus().result).toMatchObject({ status: "completed", applied: 0, skipped: 1 });
  });
});
