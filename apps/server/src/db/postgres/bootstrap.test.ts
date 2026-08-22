import { describe, expect, it } from "bun:test";
import { bootstrapPostgres } from "./bootstrap.ts";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../persistence.ts";

interface Call {
  sql: string;
  params: SqlParameters | undefined;
}

function fakePersistence(calls: Call[]): Persistence {
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string) => {
      if (sql.includes("FROM api_keys")) return { id: "bootstrap-key" } as Row;
      if (sql.includes("EXISTS")) return { present: false } as Row;
      return null;
    },
    many: async () => [],
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 } satisfies PersistenceResult<Row>;
    },
  };
  return {
    ...transaction,
    one: transaction.one,
    many: transaction.many,
    execute: transaction.execute,
    transaction: async (callback) => callback(transaction),
    close: async () => undefined,
  };
}

describe("PostgreSQL bootstrap", () => {
  it("uses the configured Workspace and Team identity", async () => {
    const calls: Call[] = [];
    const result = await bootstrapPostgres(fakePersistence(calls), {
      workspaceName: "Configured Workspace",
      workspaceUrlKey: "configured-workspace",
      teamName: "Configured Team",
      teamKey: "cfg",
    });

    expect(result.created).toBe(true);
    expect(calls.find((call) => call.sql.includes("INSERT INTO workspace"))?.params).toContain(
      "Configured Workspace",
    );
    expect(calls.find((call) => call.sql.includes("INSERT INTO workspace"))?.params).toContain(
      "configured-workspace",
    );
    expect(calls.find((call) => call.sql.includes("INSERT INTO teams"))?.params).toContain(
      "Configured Team",
    );
    expect(calls.find((call) => call.sql.includes("INSERT INTO teams"))?.params).toContain("CFG");
  });
});
