import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import type { IssueRow } from "./issues.ts";
import { createPostgresIssue, unarchivePostgresIssue } from "./postgres-issues.ts";

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
  updates: number;
} {
  let current = { ...issue };
  const activities: string[] = [];
  let updates = 0;
  let issueReads = 0;
  let releaseIssueReads: () => void = () => undefined;
  const issueReadBarrier = new Promise<void>((resolve) => {
    releaseIssueReads = resolve;
  });
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string): Promise<Row | null> => {
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
    get updates() {
      return updates;
    },
  };
}

function fakeAutoAddCreatePersistence(): {
  persistence: Persistence;
  activities: Array<Record<string, unknown>>;
  get issue(): IssueRow;
} {
  const team = {
    id: "team-1",
    key: "PB",
    name: "Platform",
    description: null,
    visibility: "public",
    access_policy: "workspace_members",
    archived_at: null,
    default_state_id: "state-1",
    timezone: "UTC",
    estimates_enabled: true,
    estimate_scale: "exponential",
    estimate_extended_scale: false,
    estimate_allow_zero: false,
    cycles_enabled: true,
    cycle_duration_weeks: 2,
    cycle_start_day: "monday",
    cycle_cooldown_days: 0,
    cycle_upcoming_count: 0,
    cycle_rollover_enabled: false,
    cycle_auto_add_enabled: true,
  };
  const state = {
    id: "state-1",
    team_id: team.id,
    name: "In Progress",
    type: "started",
    color: "#000000",
    position: 1,
  };
  const cycle = {
    id: "cycle-1",
    team_id: team.id,
    number: 1,
    name: "Current",
    starts_at: "2026-01-01T00:00:00.000Z",
    ends_at: "2026-01-14T23:59:59.000Z",
    state: "active",
    cadence_source: "manual",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
  };
  let currentIssue: IssueRow = {
    id: "issue-1",
    team_id: team.id,
    number: 1,
    title: "Created",
    description: null,
    state_id: state.id,
    priority: 0,
    assignee_id: null,
    parent_id: null,
    project_id: null,
    milestone_id: null,
    cycle_id: null,
    creator_id: viewer.id,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    team_key: team.key,
  };
  const activities: Array<Record<string, unknown>> = [];
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string, params?: SqlParameters): Promise<Row | null> => {
      if (sql.includes("FROM teams")) return team as Row;
      if (sql.includes("FROM workflow_states")) return state as Row;
      if (sql.includes("FROM issues JOIN workflow_states")) {
        return { ...currentIssue, state_type: state.type } as Row;
      }
      if (sql.includes("FROM cycles") && sql.includes("state = 'active'")) return cycle as Row;
      if (sql.includes("FROM cycles") && sql.includes("state = 'upcoming'")) return null;
      if (sql.includes("UPDATE teams") && sql.includes("next_issue_number"))
        return { number: 1 } as Row;
      if (sql.includes("UPDATE issues SET cycle_id")) {
        currentIssue = { ...currentIssue, cycle_id: cycle.id };
        return { id: currentIssue.id } as Row;
      }
      if (sql.includes("SELECT issues.*")) return currentIssue as Row;
      void params;
      return null;
    },
    many: async <Row extends object>() => [] as Row[],
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("INSERT INTO issues")) {
        currentIssue = {
          ...currentIssue,
          id: String(params?.[0]),
          team_id: String(params?.[1]),
          number: Number(params?.[2]),
          title: String(params?.[3]),
          description: params?.[4] == null ? null : String(params[4]),
          state_id: String(params?.[5]),
          priority: Number(params?.[6]),
          creator_id: String(params?.[12]),
          created_at: String(params?.[13]),
          updated_at: String(params?.[13]),
        };
      }
      if (sql.includes("INSERT INTO activity")) {
        const payload = params?.[3] === "created" ? params?.[4] : params?.[3];
        activities.push(JSON.parse(String(payload)) as Record<string, unknown>);
      }
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
    get issue() {
      return currentIssue;
    },
  };
}

describe("issues PostgreSQL", () => {
  it("auto-asigna el Cycle al crear una Issue Started", async () => {
    const fake = fakeAutoAddCreatePersistence();
    const created = await createPostgresIssue(fake.persistence, viewer, {
      teamId: "team-1",
      title: "Created started",
      stateId: "state-1",
    });

    expect(created.cycle_id).toBe("cycle-1");
    expect(fake.issue.cycle_id).toBe("cycle-1");
    expect(fake.activities).toContainEqual(
      expect.objectContaining({ from: null, to: "cycle-1", reason: "cycle_auto_add" }),
    );
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
