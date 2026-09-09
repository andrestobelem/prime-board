import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { TeamRow, WorkflowStateRow } from "./teams.ts";
import { deletePostgresWorkflowState } from "./postgres-teams.ts";

type Call = { sql: string; params?: SqlParameters };

type IssueDates = {
  id: string;
  completed_at: string | null;
  canceled_at: string | null;
};

function fakePersistence(
  sourceType: WorkflowStateRow["type"],
  targetType: WorkflowStateRow["type"],
  issue: IssueDates,
): { persistence: Persistence; calls: Call[] } {
  const calls: Call[] = [];
  const source = {
    id: "state-source",
    team_id: "team-1",
    name: "Source",
    type: sourceType,
    color: "#000000",
    position: 0,
  } as WorkflowStateRow;
  const target = {
    id: "state-target",
    team_id: "team-1",
    name: "Target",
    type: targetType,
    color: "#ffffff",
    position: 1,
  } as WorkflowStateRow;
  const team = {
    id: "team-1",
    key: "PB",
  } as TeamRow;

  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string): Promise<Row | null> => {
      if (sql.includes("SELECT default_state_id")) return { default_state_id: null } as Row;
      if (sql.includes("FROM workflow_states WHERE id = $1")) return source as Row;
      if (sql.includes("count(*)::int AS n")) return { n: 1 } as Row;
      if (sql.includes("FROM teams WHERE id = $1")) return team as Row;
      return null;
    },
    many: async <Row extends object>(sql: string): Promise<readonly Row[]> => {
      if (sql.includes("SELECT id, completed_at, canceled_at FROM issues")) return [issue] as Row[];
      if (sql.includes("FROM activity")) return [] as Row[];
      if (targetType === "completed") return [target] as Row[];
      return [target, { ...target, id: "state-completed", type: "completed" }] as Row[];
    },
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 } satisfies PersistenceResult<Row>;
    },
  };
  return {
    persistence: {
      ...transaction,
      transaction: async (callback) => callback(transaction),
      close: async () => undefined,
    },
    calls,
  };
}

describe("workflow states PostgreSQL", () => {
  it("actualiza completed_at al migrar un estado borrado a completed", async () => {
    const fake = fakePersistence("started", "completed", {
      id: "issue-1",
      completed_at: null,
      canceled_at: null,
    });
    expect(
      await deletePostgresWorkflowState(
        fake.persistence,
        "actor-1",
        "state-source",
        "state-target",
      ),
    ).toBe(1);

    const update = fake.calls.find((call) => call.sql.startsWith("UPDATE issues SET"));
    expect(update?.params?.[0]).toBe("state-target");
    expect(update?.params?.[1]).toEqual(expect.any(String));
    expect(update?.params?.[2]).toBeNull();
    expect(fake.calls.filter((call) => call.sql.includes("INSERT INTO activity")).length).toBe(2);
  });

  it("limpia completed_at y fija canceled_at al migrar a canceled", async () => {
    const fake = fakePersistence("completed", "canceled", {
      id: "issue-1",
      completed_at: "2026-01-01T00:00:00.000Z",
      canceled_at: null,
    });
    await deletePostgresWorkflowState(fake.persistence, "actor-1", "state-source", "state-target");

    const update = fake.calls.find((call) => call.sql.startsWith("UPDATE issues SET"));
    expect(update?.params?.[1]).toBeNull();
    expect(update?.params?.[2]).toEqual(expect.any(String));
    expect(fake.calls.filter((call) => call.sql.includes("INSERT INTO activity")).length).toBe(3);
  });
});
