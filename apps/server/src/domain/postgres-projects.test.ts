import { describe, expect, it } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { AuthScopeContext, PlanningAuthorizationHooks, ActorRow } from "../auth/viewer.ts";
import type { PostgresProjectDependencyRow, PostgresProjectRow } from "./postgres-projects.ts";
import type { PostgresInitiativeUpdateRow } from "./postgres-initiatives.ts";
import {
  createPostgresInitiativeUpdate,
  deletePostgresInitiativeUpdate,
} from "./postgres-initiatives.ts";
import {
  createPostgresProjectDependency,
  deletePostgresProjectDependency,
  readPostgresAuthScope,
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

interface PlanningFakeState {
  limits: string[];
  projectTeams: string[];
  initiativeTeams: string[];
  initiativeProjects: string[];
  dependencies: PostgresProjectDependencyRow[];
  updates: PostgresInitiativeUpdateRow[];
}

function planningFakePersistence(state: PlanningFakeState): Persistence {
  const projects = new Map([
    ["source", project("source")],
    ["target", project("target")],
  ]);
  const transaction = fromPartial<PersistenceTransaction>({
    one: async (sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM workspace")) return fromPartial({ id: workspaceId });
      if (sql.includes("FROM api_keys"))
        return fromPartial({ id: "key-1", revoked_at: null, expires_at: null });
      if (sql.includes("FROM projects")) return projects.get(String(params?.[0])) ?? null;
      if (sql.includes("FROM teams")) return fromPartial({ id: "team-1" });
      if (sql.includes("FROM initiatives"))
        return fromPartial({ id: "initiative-1", owner_id: "admin" });
      if (sql.includes("FROM project_dependencies"))
        return state.dependencies.find((dependency) => dependency.id === params?.[0]) ?? null;
      if (sql.includes("FROM initiative_updates"))
        return state.updates.find((update) => update.id === params?.[0]) ?? null;
      if (sql.includes("INSERT INTO initiative_updates")) {
        const update = fromPartial<PostgresInitiativeUpdateRow>({
          id: "update-created",
          initiative_id: "initiative-1",
          author_id: "admin",
          health: "on_track",
          body: "created",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        });
        state.updates.push(update);
        return update;
      }
      return null;
    },
    many: async (sql: string) => {
      if (sql.includes("api_key_team_limits"))
        return state.limits.map((teamId) => fromPartial({ team_id: teamId }));
      if (sql.includes("project_teams"))
        return state.projectTeams.map((teamId) => fromPartial({ team_id: teamId }));
      if (sql.includes("initiative_teams"))
        return state.initiativeTeams.map((teamId) => fromPartial({ team_id: teamId }));
      if (sql.includes("initiative_projects"))
        return state.initiativeProjects.map((projectId) => fromPartial({ project_id: projectId }));
      return [];
    },
    execute: async (sql: string) => {
      if (sql.includes("DELETE FROM project_dependencies")) {
        state.dependencies = [];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM initiative_updates")) {
        state.updates = [];
        return { rows: [], rowCount: 1 };
      }
      throw new Error("unexpected fake PostgreSQL write");
    },
  });
  return fromPartial<Persistence>({
    transaction: async <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) =>
      callback(transaction),
    close: async () => undefined,
  });
}

function barrierHooks(change: () => void): {
  hooks: PlanningAuthorizationHooks;
  ready: Promise<void>;
  release: () => void;
} {
  let signalReady!: () => void;
  let releaseGate!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    hooks: {
      beforeAuthorization: async () => {
        change();
        signalReady();
        await gate;
      },
    },
    ready,
    release: releaseGate,
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

describe("PostgreSQL planning auth scope", () => {
  it("rejects a Team-limit change after authentication without a write", async () => {
    const auth = fromPartial<AuthScopeContext>({ keyId: "key-1", teamIds: ["team-1"] });
    const stable = fromPartial<PersistenceTransaction>({
      one: async () => fromPartial({ id: "key-1", revoked_at: null, expires_at: null }),
      many: async () => [fromPartial({ team_id: "team-1" })],
    });
    await expect(readPostgresAuthScope(stable, auth, workspaceId)).resolves.toEqual({
      keyId: "key-1",
      teamIds: ["team-1"],
    });

    const changed = fromPartial<PersistenceTransaction>({
      one: async () => fromPartial({ id: "key-1", revoked_at: null, expires_at: null }),
      many: async () => [fromPartial({ team_id: "team-2" })],
    });
    await expect(readPostgresAuthScope(changed, auth, workspaceId)).rejects.toMatchObject({
      extensions: { code: "UNAUTHORIZED" },
    });
  });

  it("uses a fake PostgreSQL transaction barrier to reject a changed key scope", async () => {
    const dependencies: PostgresProjectDependencyRow[] = [];
    const state = {
      limits: ["team-1"],
      projectTeams: ["team-1"],
      dependencies,
    };
    const source = project("source");
    const target = project("target");
    let release!: () => void;
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = fromPartial<PersistenceTransaction>({
      one: async (sql: string, params?: SqlParameters) => {
        if (sql.includes("FROM workspace")) return fromPartial({ id: workspaceId });
        if (sql.includes("FROM api_keys"))
          return fromPartial({ id: "key-1", revoked_at: null, expires_at: null });
        if (sql.includes("FROM projects")) return params?.[0] === "source" ? source : target;
        if (sql.includes("FROM teams")) return fromPartial({ id: "team-1" });
        if (sql.includes("FROM project_dependencies")) return null;
        return null;
      },
      many: async (sql: string) => {
        if (sql.includes("api_key_team_limits"))
          return state.limits.map((teamId) => fromPartial({ team_id: teamId }));
        if (sql.includes("project_teams"))
          return state.projectTeams.map((teamId) => fromPartial({ team_id: teamId }));
        return [];
      },
      execute: async () => {
        throw new Error("dependency write must not run");
      },
    });
    const persistence = fromPartial<Persistence>({
      transaction: async <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) =>
        callback(transaction),
      close: async () => undefined,
    });
    const viewer = fromPartial<ActorRow>({ id: "admin", workspace_role: "admin" });
    const auth = fromPartial<AuthScopeContext>({ keyId: "key-1", teamIds: ["team-1"] });
    const hooks: PlanningAuthorizationHooks = {
      beforeAuthorization: async () => {
        state.limits = ["team-2"];
        signalReady();
        await gate;
      },
    };
    const operation = createPostgresProjectDependency(
      persistence,
      { projectId: "source", dependsOnProjectId: "target" },
      workspaceId,
      viewer,
      auth,
      hooks,
    );
    await ready;
    release();
    await expect(operation).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
    expect(state.dependencies).toHaveLength(0);
  });
});

describe("PostgreSQL planning scope barriers", () => {
  function stateWithAuth(): PlanningFakeState {
    return {
      limits: ["team-1"],
      projectTeams: ["team-1"],
      initiativeTeams: ["team-1"],
      initiativeProjects: [],
      dependencies: [
        {
          id: "dependency-1",
          project_id: "source",
          depends_on_project_id: "target",
          type: "blocks",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      updates: [],
    };
  }

  it("uses the fake PostgreSQL barrier for dependency delete without a write", async () => {
    const state = stateWithAuth();
    const fake = planningFakePersistence(state);
    const barrier = barrierHooks(() => {
      state.limits = ["team-2"];
    });
    const viewer = fromPartial<ActorRow>({ id: "admin", workspace_role: "admin" });
    const auth = fromPartial<AuthScopeContext>({ keyId: "key-1", teamIds: ["team-1"] });
    const operation = deletePostgresProjectDependency(
      fake,
      "dependency-1",
      workspaceId,
      viewer,
      auth,
      barrier.hooks,
    );
    await barrier.ready;
    barrier.release();
    await expect(operation).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
    expect(state.dependencies).toHaveLength(1);
  });

  it("uses the fake PostgreSQL barrier for status create without a write", async () => {
    const state = stateWithAuth();
    const fake = planningFakePersistence(state);
    const barrier = barrierHooks(() => {
      state.limits = ["team-2"];
    });
    const viewer = fromPartial<ActorRow>({ id: "admin", workspace_role: "admin" });
    const auth = fromPartial<AuthScopeContext>({ keyId: "key-1", teamIds: ["team-1"] });
    const operation = createPostgresInitiativeUpdate(
      fake,
      viewer,
      "initiative-1",
      { health: "on_track", body: "status" },
      workspaceId,
      auth,
      barrier.hooks,
    );
    await barrier.ready;
    barrier.release();
    await expect(operation).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
    expect(state.updates).toHaveLength(0);
  });

  it("uses the fake PostgreSQL barrier for status delete without a write", async () => {
    const state = stateWithAuth();
    state.updates = [
      fromPartial<PostgresInitiativeUpdateRow>({
        id: "update-1",
        initiative_id: "initiative-1",
        author_id: "admin",
        health: "on_track",
        body: "status",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const fake = planningFakePersistence(state);
    const barrier = barrierHooks(() => {
      state.limits = ["team-2"];
    });
    const viewer = fromPartial<ActorRow>({ id: "admin", workspace_role: "admin" });
    const auth = fromPartial<AuthScopeContext>({ keyId: "key-1", teamIds: ["team-1"] });
    const operation = deletePostgresInitiativeUpdate(
      fake,
      viewer,
      "update-1",
      workspaceId,
      auth,
      barrier.hooks,
    );
    await barrier.ready;
    barrier.release();
    await expect(operation).rejects.toMatchObject({ extensions: { code: "UNAUTHORIZED" } });
    expect(state.updates).toHaveLength(1);
  });
});
