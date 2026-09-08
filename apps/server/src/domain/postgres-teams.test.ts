import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { WorkflowStateRow } from "./teams.ts";
import { updatePostgresWorkflowState } from "./postgres-teams.ts";

function fakePersistence(state: WorkflowStateRow): {
  persistence: Persistence;
  updates: Array<{ sql: string; params: SqlParameters | undefined }>;
} {
  const updates: Array<{ sql: string; params: SqlParameters | undefined }> = [];
  const transaction: PersistenceTransaction = {
    async one<Row extends object>(sql: string, params?: SqlParameters): Promise<Row | null> {
      if (sql.startsWith("SELECT * FROM workflow_states")) return state as Row;
      if (sql.startsWith("UPDATE workflow_states")) {
        updates.push({ sql, params });
        return { ...state, description: params?.[0] as string | null } as Row;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async many<Row extends object>(): Promise<readonly Row[]> {
      return [];
    },
    async execute<Row extends object>(): Promise<PersistenceResult<Row>> {
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    persistence: {
      ...transaction,
      async transaction<Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) {
        return callback(transaction);
      },
      async close() {},
    },
    updates,
  };
}

const state: WorkflowStateRow = {
  id: "state-1",
  team_id: "team-1",
  name: "Todo",
  type: "unstarted",
  color: "#95a2b3",
  position: 1,
  description: null,
  is_reserved: false,
};

describe("PostgreSQL workflow states", () => {
  it("persists a description update", async () => {
    const fake = fakePersistence(state);

    const updated = await updatePostgresWorkflowState(fake.persistence, state.id, {
      description: "Ready for implementation",
    });

    expect(updated.description).toBe("Ready for implementation");
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]?.sql).toContain("description = $1");
    expect(fake.updates[0]?.params?.[0]).toBe("Ready for implementation");
  });
});
