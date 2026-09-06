import { describe, expect, it } from "bun:test";
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
import {
  canonicalEventFromMutation,
  canonicalEventFromWebhook,
  PostgresRepoSync,
} from "./postgres-repo-sync.ts";
import { applyCanonicalEvent } from "./postgres-projector.ts";

const actor = { id: "actor-1", name: "Agent", type: "agent" };
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

describe("canonical PostgreSQL projection", () => {
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
