import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { PostgresProjectDependencyRow, PostgresProjectRow } from "./postgres-projects.ts";
import {
  createPostgresProjectDependency,
  deletePostgresProjectDependency,
} from "./postgres-projects.ts";

const workspaceId = "workspace-1";

function project(id: string): PostgresProjectRow {
  return {
    id,
    name: id,
    description: null,
    state: "backlog",
    lead_id: null,
    target_date: null,
    start_date: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
  };
}

interface FakeOptions {
  failAfterInsert?: boolean;
  failAfterDelete?: boolean;
}

interface FakeState {
  dependencies: PostgresProjectDependencyRow[];
}

function fakePersistence(options: FakeOptions = {}): {
  persistence: Persistence;
  snapshot: () => FakeState;
  transactions: () => number;
} {
  let state: FakeState = {
    dependencies: [
      {
        id: "dependency-1",
        project_id: "source",
        depends_on_project_id: "target",
        type: "blocks",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  let transactionCount = 0;
  const projects = new Map([
    ["source", project("source")],
    ["target", project("target")],
  ]);

  const cloneState = (value: FakeState): FakeState => ({
    dependencies: value.dependencies.map((dependency) => ({ ...dependency })),
  });

  const operations = (working: FakeState): PersistenceTransaction => ({
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM workspace WHERE")) {
        return (params?.[0] === workspaceId ? { id: workspaceId } : null) as Row | null;
      }
      if (sql.includes("INSERT INTO project_dependencies")) {
        const [id, projectId, targetId, type, createdAt] = params ?? [];
        const dependency: PostgresProjectDependencyRow = {
          id: String(id),
          project_id: String(projectId),
          depends_on_project_id: String(targetId),
          type: type === "related" ? "related" : "blocks",
          created_at: String(createdAt),
        };
        working.dependencies.push(dependency);
        if (options.failAfterInsert) throw new Error("simulated insert failure");
        return dependency as Row;
      }
      if (sql.includes("FROM projects")) {
        return (projects.get(String(params?.[0])) ?? null) as Row | null;
      }
      if (sql.includes("FROM project_dependencies")) {
        return (working.dependencies.find((dependency) => dependency.id === params?.[0]) ??
          null) as Row | null;
      }
      return null;
    },
    many: async <Row extends object>() => [] as Row[],
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("DELETE FROM project_dependencies")) {
        const index = working.dependencies.findIndex((dependency) => dependency.id === params?.[0]);
        if (index < 0) return { rows: [], rowCount: 0 } satisfies PersistenceResult<Row>;
        const [deleted] = working.dependencies.splice(index, 1);
        if (options.failAfterDelete) throw new Error("simulated delete failure");
        return {
          rows: deleted ? [deleted as Row] : [],
          rowCount: 1,
        } satisfies PersistenceResult<Row>;
      }
      return { rows: [], rowCount: 1 } satisfies PersistenceResult<Row>;
    },
  });

  const persistenceOperations = operations(state);
  const persistence: Persistence = {
    ...persistenceOperations,
    transaction: async <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) => {
      transactionCount += 1;
      const working = cloneState(state);
      const result = await callback(operations(working));
      state = working;
      return result;
    },
    close: async () => undefined,
  };
  return {
    persistence,
    snapshot: () => cloneState(state),
    transactions: () => transactionCount,
  };
}

describe("PostgreSQL project dependencies", () => {
  it("creates a related dependency atomically with one timestamp", async () => {
    const fake = fakePersistence();
    const created = await createPostgresProjectDependency(
      fake.persistence,
      { projectId: "source", dependsOnProjectId: "target", type: "related" },
      workspaceId,
    );

    expect(created).toMatchObject({
      project_id: "source",
      depends_on_project_id: "target",
      type: "related",
    });
    const dependencies = fake.snapshot().dependencies;
    expect(dependencies).toHaveLength(2);
    expect(created.created_at).toBe(dependencies[1]!.created_at);
    expect(fake.transactions()).toBe(1);
  });

  it("rejects self-dependencies, missing references and invalid types without writes", async () => {
    const self = fakePersistence();
    await expect(
      createPostgresProjectDependency(
        self.persistence,
        { projectId: "source", dependsOnProjectId: "source" },
        workspaceId,
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    expect(self.snapshot().dependencies).toHaveLength(1);

    const missing = fakePersistence();
    await expect(
      createPostgresProjectDependency(
        missing.persistence,
        { projectId: "source", dependsOnProjectId: "missing" },
        workspaceId,
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(missing.snapshot().dependencies).toHaveLength(1);

    const invalid = fakePersistence();
    await expect(
      createPostgresProjectDependency(
        invalid.persistence,
        { projectId: "source", dependsOnProjectId: "target", type: "follows" },
        workspaceId,
      ),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    expect(invalid.snapshot().dependencies).toHaveLength(1);

    const foreignWorkspace = fakePersistence();
    await expect(
      createPostgresProjectDependency(
        foreignWorkspace.persistence,
        { projectId: "source", dependsOnProjectId: "target" },
        "workspace-missing",
      ),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(foreignWorkspace.snapshot().dependencies).toHaveLength(1);
  });

  it("rolls back a failed insert and deletes inside a transaction", async () => {
    const failedInsert = fakePersistence({ failAfterInsert: true });
    await expect(
      createPostgresProjectDependency(
        failedInsert.persistence,
        { projectId: "source", dependsOnProjectId: "target" },
        workspaceId,
      ),
    ).rejects.toThrow("simulated insert failure");
    expect(failedInsert.snapshot().dependencies).toHaveLength(1);

    const failedDelete = fakePersistence({ failAfterDelete: true });
    await expect(
      deletePostgresProjectDependency(failedDelete.persistence, "dependency-1", workspaceId),
    ).rejects.toThrow("simulated delete failure");
    expect(failedDelete.snapshot().dependencies).toHaveLength(1);
  });

  it("deletes an existing dependency and reports missing ids consistently", async () => {
    const fake = fakePersistence();
    await expect(
      deletePostgresProjectDependency(fake.persistence, "dependency-1", workspaceId),
    ).resolves.toBe(true);
    expect(fake.snapshot().dependencies).toHaveLength(0);

    await expect(
      deletePostgresProjectDependency(fake.persistence, "dependency-1", workspaceId),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
