import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { IssueRow } from "./issues.ts";
import { getPostgresIssue, unarchivePostgresIssue } from "./postgres-issues.ts";

const viewer: ActorRow = {
  id: "actor-1",
  name: "admin",
  email: null,
  type: "human",
  workspace_role: "admin",
  status: "active",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const issue: IssueRow = {
  id: "issue-1",
  team_id: "team-1",
  number: 1,
  title: "Restorable",
  description: "Keep this",
  state_id: "state-1",
  priority: 2,
  assignee_id: null,
  parent_id: null,
  project_id: null,
  milestone_id: null,
  cycle_id: null,
  creator_id: "actor-1",
  sort_order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  archived_at: "2026-01-02T00:00:00.000Z",
  team_key: "PB",
};

function fakePersistence(synchronizeReads = false): {
  persistence: Persistence;
  activities: string[];
  queries: string[];
  updates: number;
} {
  let current = { ...issue };
  const activities: string[] = [];
  const queries: string[] = [];
  let updates = 0;
  let issueReads = 0;
  let releaseIssueReads: () => void = () => undefined;
  const issueReadBarrier = new Promise<void>((resolve) => {
    releaseIssueReads = resolve;
  });
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string): Promise<Row | null> => {
      queries.push(sql);
      if (sql.includes("FROM teams")) return { id: current.team_id, archived_at: null } as Row;
      if (sql.includes("SELECT issues.*")) {
        const snapshot = { ...current };
        if (synchronizeReads && issueReads < 2) {
          issueReads += 1;
          if (issueReads === 2) releaseIssueReads();
          await issueReadBarrier;
        }
        return snapshot as Row;
      }
      return null;
    },
    many: async <Row extends object>() => [] as Row[],
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("UPDATE issues SET archived_at = NULL")) {
        const changed = current.archived_at !== null;
        if (changed) {
          current = { ...current, archived_at: null, updated_at: String(params?.[0]) };
          updates += 1;
        }
        return { rows: [], rowCount: changed ? 1 : 0 } satisfies PersistenceResult<Row>;
      }
      if (sql.includes("INSERT INTO activity")) activities.push(String(params?.[3]));
      return { rows: [], rowCount: 1 } satisfies PersistenceResult<Row>;
    },
  };
  return {
    persistence: {
      ...transaction,
      transaction: async (callback) => callback(transaction),
      close: async () => undefined,
    },
    activities,
    queries,
    get updates() {
      return updates;
    },
  };
}

describe("issues PostgreSQL", () => {
  it("carga team_key junto al Issue para los payloads de Webhooks", async () => {
    const fake = fakePersistence();
    const loaded = await getPostgresIssue(fake.persistence, "issue-1");

    expect(loaded?.team_key).toBe("PB");
    expect(fake.queries.some((query) => query.includes("teams.key AS team_key"))).toBe(true);
  });

  it("restaura de forma idempotente y registra una sola Activity", async () => {
    const fake = fakePersistence();
    const restored = await unarchivePostgresIssue(fake.persistence, viewer, "PB-1");
    const again = await unarchivePostgresIssue(fake.persistence, viewer, "PB-1");

    expect(restored.row.archived_at).toBeNull();
    expect(again.row.archived_at).toBeNull();
    expect(restored.changed).toBe(true);
    expect(again.changed).toBe(false);
    expect(fake.updates).toBe(1);
    expect(fake.activities).toEqual(["unarchived"]);
  });

  it("serializa restauraciones concurrentes y emite una sola Activity", async () => {
    const fake = fakePersistence(true);
    const results = await Promise.all([
      unarchivePostgresIssue(fake.persistence, viewer, "PB-1"),
      unarchivePostgresIssue(fake.persistence, viewer, "PB-1"),
    ]);

    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(results.every((result) => result.row.archived_at === null)).toBe(true);
    expect(fake.updates).toBe(1);
    expect(fake.activities).toEqual(["unarchived"]);
  });
});
