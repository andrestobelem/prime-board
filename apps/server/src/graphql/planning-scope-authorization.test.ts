import { afterEach, describe, expect, it } from "bun:test";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  createProject,
  createProjectDependency,
  deleteProjectDependency,
} from "../domain/projects.ts";
import {
  createInitiative,
  createInitiativeUpdate,
  deleteInitiativeUpdate,
} from "../domain/initiatives.ts";
import type { ActorRow, AuthScopeContext, PlanningAuthorizationHooks } from "../auth/viewer.ts";
import { createApiKey } from "../domain/actors.ts";
import { createTeam } from "../domain/teams.ts";
import { bootstrap } from "../db/seed.ts";
import { openDatabase } from "../db/database.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp | null = null;

afterEach(() => {
  app?.stop();
  app = null;
});

function countRows(table: "project_dependencies" | "initiative_updates"): number {
  const row = app!.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

function workspaceId(): string {
  const row = app!.db.query<{ id: string }, []>("SELECT id FROM workspace LIMIT 1").get();
  if (!row) throw new Error("Workspace fixture is incomplete");
  return row.id;
}

function teamWorkspaceId(teamId: string): string | null {
  const row = app!.db
    .query<{ workspace_id: string | null }, [string]>(
      "SELECT workspace_id FROM teams WHERE id = ?1",
    )
    .get(teamId);
  if (!row) throw new Error("Team fixture is incomplete");
  return row.workspace_id;
}

function replaceKeyTeams(keyId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1").run(keyId);
    app!.db
      .query(
        "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(keyId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceProjectTeams(projectId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM project_teams WHERE project_id = ?1").run(projectId);
    app!.db
      .query("INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES (?1, ?2, ?3)")
      .run(projectId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceInitiativeTeams(initiativeId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(initiativeId);
    app!.db
      .query(
        "INSERT INTO initiative_teams (initiative_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(initiativeId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceInitiativeProjects(initiativeId: string, projectId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(initiativeId);
    app!.db
      .query(
        "INSERT INTO initiative_projects (initiative_id, project_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(initiativeId, projectId, teamWorkspaceId(primaryTeamId()));
  })();
}

function primaryTeamId(): string {
  const row = app!.db.query<{ id: string }, []>("SELECT id FROM teams WHERE key = 'PB'").get();
  if (!row) throw new Error("Primary Team fixture is incomplete");
  return row.id;
}

async function createGraphqlTeam(key: string): Promise<string> {
  const result = await gql(
    app!,
    "mutation($key: String!) { teamCreate(input: { key: $key, name: $key }) { team { id } } }",
    { key },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.teamCreate.team.id;
}

async function createActorWithKey(
  name: string,
  teamIds: string[],
): Promise<{ actorId: string; keyId: string; key: string }> {
  const actorResult = await gql(
    app!,
    "mutation($name: String!) { actorCreate(input: { name: $name, type: AGENT }) { actor { id } } }",
    { name },
  );
  expect(actorResult.errors).toBeUndefined();
  const actorId = actorResult.data!.actorCreate.actor.id;
  const keyResult = await gql(
    app!,
    `mutation($actorId: ID!, $teamIds: [ID!]) { apiKeyCreate(input: { actorId: $actorId, name: "scope-key", scopes: [WRITE], teamIds: $teamIds }) { key } }`,
    { actorId, teamIds },
  );
  expect(keyResult.errors).toBeUndefined();
  const keyRow = app!.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM api_keys WHERE actor_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
    .get(actorId);
  if (!keyRow) throw new Error("API key fixture is incomplete");
  return { actorId, keyId: keyRow.id, key: keyResult.data!.apiKeyCreate.key };
}

async function addMembership(actorId: string, teamId: string): Promise<void> {
  const result = await gql(
    app!,
    "mutation($actorId: ID!, $teamId: ID!) { teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success } }",
    { actorId, teamId },
  );
  expect(result.errors).toBeUndefined();
}

function limitedViewer(actorId: string): ActorRow {
  return fromPartial<ActorRow>({ id: actorId, workspace_role: "member" });
}

function limitedAuth(keyId: string, teamId: string): AuthScopeContext {
  return fromPartial<AuthScopeContext>({ keyId, teamIds: [teamId] });
}

interface FilePlanningFixture {
  rootDir: string;
  dbPath: string;
  db: Database;
  workspaceId: string;
  actor: ActorRow;
  primaryTeamId: string;
  secondaryTeamId: string;
  keyId: string;
  sourceId: string;
  targetId: string;
  initiativeId: string;
}

function filePlanningFixture(limitedToPrimary: boolean): FilePlanningFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "prb-planning-scope-"));
  const dbPath = join(rootDir, "board.sqlite");
  const db = openDatabase(dbPath);
  bootstrap(db);
  const workspace = db.query<{ id: string }, []>("SELECT id FROM workspace LIMIT 1").get();
  const actor = db
    .query<ActorRow, []>("SELECT * FROM actors WHERE workspace_role = 'admin' LIMIT 1")
    .get();
  const primaryTeam = db
    .query<{ id: string }, []>("SELECT id FROM teams WHERE key = 'PB' LIMIT 1")
    .get();
  if (!workspace || !actor || !primaryTeam) throw new Error("Planning fixture is incomplete");
  const secondaryTeam = createTeam(
    db,
    { key: "CON618", name: "Concurrent Team" },
    actor.id,
    workspace.id,
  );
  const key = createApiKey(db, {
    actorId: actor.id,
    name: "concurrency scope key",
    scopes: ["write"],
    teamIds: limitedToPrimary ? [primaryTeam.id] : null,
    workspaceId: workspace.id,
  });
  const source = createProject(
    db,
    { name: "concurrent source", teamIds: [primaryTeam.id] },
    workspace.id,
  );
  const target = createProject(
    db,
    { name: "concurrent target", teamIds: [primaryTeam.id] },
    workspace.id,
  );
  const initiative = createInitiative(
    db,
    actor.id,
    {
      name: "concurrent initiative",
      projectIds: [source.id],
      teamIds: [primaryTeam.id],
    },
    workspace.id,
  );
  return {
    rootDir,
    dbPath,
    db,
    workspaceId: workspace.id,
    actor,
    primaryTeamId: primaryTeam.id,
    secondaryTeamId: secondaryTeam.id,
    keyId: key.row.id,
    sourceId: source.id,
    targetId: target.id,
    initiativeId: initiative.id,
  };
}

const WRITER_READY = 1;
const WRITER_START = 2;
const WRITER_ATTEMPTED = 3;
const WRITER_BLOCKED = 4;
const WRITER_RELEASE = 5;
const WRITER_DONE = 6;
const WRITER_FAILED = 7;

function waitForState(state: Int32Array, ...expected: number[]): number {
  while (true) {
    const current = Atomics.load(state, 0);
    if (expected.includes(current)) return current;
    // The notify handshake synchronizes normal progress; this timeout only
    // prevents a failed worker from hanging the test forever.
    const result = Atomics.wait(state, 0, current, 10_000);
    if (result === "timed-out") throw new Error("Concurrent SQLite worker timed out");
  }
}

interface SqliteWriter {
  waitReady(): void;
  begin(): void;
  waitDoneOrBlocked(): void;
  stop(): void;
}

function startSqliteWriter(
  fixture: FilePlanningFixture,
  mode: "limits-add" | "limits-clear" | "project-team-change",
  teamId = fixture.secondaryTeamId,
): SqliteWriter {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const databaseModule = join(import.meta.dir, "../db/database.ts");
  const workerSource = [
    'import { workerData } from "node:worker_threads";',
    "import { openDatabase } from " + JSON.stringify(databaseModule) + ";",
    "const { state: sharedState, dbPath, mode, workspaceId, keyId, teamId, projectId, secondaryTeamId } = workerData;",
    "const state = new Int32Array(sharedState);",
    "const setState = (value) => { Atomics.store(state, 0, value); Atomics.notify(state, 0); };",
    `const waitFor = (value) => { while (Atomics.load(state, 0) !== value) Atomics.wait(state, 0, Atomics.load(state, 0)); };`,
    "const db = openDatabase(dbPath);",
    `setState(${WRITER_READY});`,
    `waitFor(${WRITER_START});`,
    `setState(${WRITER_ATTEMPTED});`,
    "const mutate = () => db.transaction(() => {",
    "  if (mode === 'limits-add') {",
    "    db.query('INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)').run(keyId, teamId, workspaceId);",
    "  } else if (mode === 'limits-clear') {",
    "    db.query('DELETE FROM api_key_team_limits WHERE api_key_id = ?1').run(keyId);",
    "  } else {",
    "    db.query('DELETE FROM project_teams WHERE project_id = ?1').run(projectId);",
    "    db.query('INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES (?1, ?2, ?3)').run(projectId, secondaryTeamId, workspaceId);",
    "  }",
    "})();",
    "try {",
    "  mutate();",
    `setState(${WRITER_DONE});`,
    "} catch (error) {",
    `setState(${WRITER_BLOCKED});`,
    `waitFor(${WRITER_RELEASE});`,
    `  try { mutate(); setState(${WRITER_DONE}); }`,
    `  catch { setState(${WRITER_FAILED}); }`,
    "}",
    "db.close();",
  ].join("\n");
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      state: state.buffer,
      dbPath: fixture.dbPath,
      mode,
      workspaceId: fixture.workspaceId,
      keyId: fixture.keyId,
      teamId,
      projectId: fixture.targetId,
      secondaryTeamId: fixture.secondaryTeamId,
    },
  });
  worker.on("error", () => {
    Atomics.store(state, 0, WRITER_FAILED);
    Atomics.notify(state, 0);
  });
  return {
    waitReady: () => {
      expect(waitForState(state, WRITER_READY, WRITER_FAILED)).toBe(WRITER_READY);
    },
    begin: () => {
      Atomics.store(state, 0, WRITER_START);
      Atomics.notify(state, 0);
    },
    waitDoneOrBlocked: () => {
      const result = waitForState(state, WRITER_DONE, WRITER_BLOCKED, WRITER_FAILED);
      if (result === WRITER_BLOCKED) {
        Atomics.store(state, 0, WRITER_RELEASE);
        Atomics.notify(state, 0);
        expect(waitForState(state, WRITER_DONE, WRITER_FAILED)).toBe(WRITER_DONE);
      } else {
        expect(result).toBe(WRITER_DONE);
      }
    },
    stop: () => {
      void worker.terminate();
    },
  };
}

function startWriterDuringTransaction(
  fixture: FilePlanningFixture,
  mode: "limits-add" | "limits-clear" | "project-team-change",
  teamId = fixture.secondaryTeamId,
): SqliteWriter {
  const writer = startSqliteWriter(fixture, mode, teamId);
  try {
    writer.waitReady();
    writer.begin();
    writer.waitDoneOrBlocked();
    return writer;
  } catch (error) {
    writer.stop();
    throw error;
  }
}

function closeFilePlanningFixture(fixture: FilePlanningFixture): void {
  fixture.db.close();
  rmSync(fixture.rootDir, { recursive: true, force: true });
}

function stopWriter(writer: SqliteWriter | null): void {
  writer?.stop();
}

function expectSqliteBusySnapshot(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (!(caught instanceof Error)) throw new Error("SQLite mutation did not throw an Error");
  const code = "code" in caught && typeof caught.code === "string" ? caught.code : "";
  const message = caught.message.toLowerCase();
  expect(
    code === "SQLITE_BUSY_SNAPSHOT" ||
      (code === "SQLITE_BUSY" && message.includes("locked")) ||
      message.includes("sqlite_busy_snapshot") ||
      message.includes("database is locked"),
  ).toBe(true);
}

function expectUnauthorized(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  if (!caught || typeof caught !== "object" || !("extensions" in caught)) {
    throw new Error("Authorization mutation did not return an API error");
  }
  const extensions = caught.extensions;
  if (!extensions || typeof extensions !== "object" || !("code" in extensions)) {
    throw new Error("Authorization mutation did not include an error code");
  }
  expect(extensions.code).toBe("UNAUTHORIZED");
}

describe("planning Team-limit authorization scope", () => {
  it("rejects dependency create/delete after project_teams changes without writes", async () => {
    app = createTestApp();
    const primary = primaryTeamId();
    const secondary = await createGraphqlTeam("SDEP618");
    const limited = await createActorWithKey("scope dependency actor", [primary]);
    await addMembership(limited.actorId, primary);
    await addMembership(limited.actorId, secondary);

    const sourceResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "scope source", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(sourceResult.errors).toBeUndefined();
    const sourceId = sourceResult.data!.projectCreate.project.id;
    const targetResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "scope target", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(targetResult.errors).toBeUndefined();
    const targetId = targetResult.data!.projectCreate.project.id;
    const viewer = limitedViewer(limited.actorId);
    const auth = limitedAuth(limited.keyId, primary);

    expect(() =>
      createProjectDependency(
        app!.db,
        { projectId: sourceId, dependsOnProjectId: targetId },
        "foreign-workspace",
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(0);

    replaceKeyTeams(limited.keyId, secondary);
    expect(() =>
      createProjectDependency(
        app!.db,
        { projectId: sourceId, dependsOnProjectId: targetId },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(0);

    replaceKeyTeams(limited.keyId, primary);
    replaceProjectTeams(targetId, primary);
    const dependencyResult = await gql(
      app,
      "mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { dependency { id } } }",
      { source: sourceId, target: targetId },
    );
    expect(dependencyResult.errors).toBeUndefined();
    const dependencyId = dependencyResult.data!.projectDependencyCreate.dependency.id;
    replaceProjectTeams(targetId, secondary);
    expect(() =>
      deleteProjectDependency(app!.db, dependencyId, workspaceId(), viewer, auth),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(1);
  });

  it("rejects status create/delete after initiative relation changes without writes", async () => {
    app = createTestApp();
    const primary = primaryTeamId();
    const secondary = await createGraphqlTeam("SSTA618");
    const limited = await createActorWithKey("scope status actor", [primary]);
    await addMembership(limited.actorId, primary);
    await addMembership(limited.actorId, secondary);

    const primaryProjectResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "status primary", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(primaryProjectResult.errors).toBeUndefined();
    const primaryProjectId = primaryProjectResult.data!.projectCreate.project.id;
    const secondaryProjectResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "status secondary", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: secondary },
    );
    expect(secondaryProjectResult.errors).toBeUndefined();
    const secondaryProjectId = secondaryProjectResult.data!.projectCreate.project.id;
    const initiativeResult = await gql(
      app,
      `mutation($teamId: ID!, $projectId: ID!) { initiativeCreate(input: { name: "scope initiative", teamIds: [$teamId], projectIds: [$projectId] }) { initiative { id } } }`,
      { teamId: primary, projectId: primaryProjectId },
      limited.key,
    );
    expect(initiativeResult.errors).toBeUndefined();
    const initiativeId = initiativeResult.data!.initiativeCreate.initiative.id;
    const viewer = limitedViewer(limited.actorId);
    const auth = limitedAuth(limited.keyId, primary);

    replaceKeyTeams(limited.keyId, secondary);
    expect(() =>
      createInitiativeUpdate(
        app!.db,
        initiativeId,
        limited.actorId,
        { body: "scope changed", health: "on_track" },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("initiative_updates")).toBe(0);

    replaceKeyTeams(limited.keyId, primary);
    replaceInitiativeTeams(initiativeId, secondary);
    expect(() =>
      createInitiativeUpdate(
        app!.db,
        initiativeId,
        limited.actorId,
        { body: "scope changed", health: "on_track" },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("initiative_updates")).toBe(0);
    replaceInitiativeTeams(initiativeId, primary);
    const update = createInitiativeUpdate(
      app!.db,
      initiativeId,
      limited.actorId,
      { body: "scope stable", health: "on_track" },
      workspaceId(),
      viewer,
      auth,
    );
    expect(update.initiative_id).toBe(initiativeId);
    replaceInitiativeProjects(initiativeId, secondaryProjectId);
    expect(() => deleteInitiativeUpdate(app!.db, update.id, workspaceId(), viewer, auth)).toThrow();
    expect(countRows("initiative_updates")).toBe(1);
    expect(primaryProjectId).not.toBe(secondaryProjectId);
  });
});

describe("SQLite planning transaction interleavings", () => {
  it("rejects a scope changed before the transaction with UNAUTHORIZED", () => {
    const fixture = filePlanningFixture(true);
    try {
      fixture.db.transaction(() => {
        fixture.db
          .query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1")
          .run(fixture.keyId);
        fixture.db
          .query(
            "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
          )
          .run(fixture.keyId, fixture.secondaryTeamId, fixture.workspaceId);
      })();
      const auth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      expectUnauthorized(() =>
        createProjectDependency(
          fixture.db,
          { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
          fixture.workspaceId,
          fixture.actor,
          auth,
        ),
      );
      const dependencies = fixture.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
        .get();
      expect(dependencies?.count).toBe(0);
    } finally {
      closeFilePlanningFixture(fixture);
    }
  });
  it("rejects a project Team change during authorization without a dependency write", () => {
    const fixture = filePlanningFixture(true);
    let writer: SqliteWriter | null = null;
    try {
      const auth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "project-team-change");
        },
      };
      expectSqliteBusySnapshot(() =>
        createProjectDependency(
          fixture.db,
          { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
          fixture.workspaceId,
          fixture.actor,
          auth,
          hooks,
        ),
      );
      const dependencies = fixture.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
        .get();
      const targetTeams = fixture.db
        .query<{ team_id: string }, [string]>(
          "SELECT team_id FROM project_teams WHERE project_id = ?1",
        )
        .all(fixture.targetId);
      expect(dependencies?.count).toBe(0);
      expect(targetTeams.map((row) => row.team_id)).toEqual([fixture.secondaryTeamId]);
      expectUnauthorized(() =>
        createProjectDependency(
          fixture.db,
          { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
          fixture.workspaceId,
          fixture.actor,
          auth,
        ),
      );
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
          .get()?.count,
      ).toBe(0);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });

  it("rejects status creation after a key limit changes during authorization", () => {
    const fixture = filePlanningFixture(true);
    let writer: SqliteWriter | null = null;
    try {
      const auth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "limits-clear", fixture.secondaryTeamId);
        },
      };
      expectSqliteBusySnapshot(() =>
        createInitiativeUpdate(
          fixture.db,
          fixture.initiativeId,
          fixture.actor.id,
          { body: "concurrent status", health: "on_track" },
          fixture.workspaceId,
          fixture.actor,
          auth,
          hooks,
        ),
      );
      const updates = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM initiative_updates WHERE initiative_id = ?1",
        )
        .get(fixture.initiativeId);
      const limits = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
        )
        .get(fixture.keyId);
      expect(updates?.count).toBe(0);
      expect(limits?.count).toBe(0);
      const retryAuth = fromPartial<AuthScopeContext>({ keyId: fixture.keyId, teamIds: null });
      const retried = createInitiativeUpdate(
        fixture.db,
        fixture.initiativeId,
        fixture.actor.id,
        { body: "concurrent status", health: "on_track" },
        fixture.workspaceId,
        fixture.actor,
        retryAuth,
      );
      expect(retried.initiative_id).toBe(fixture.initiativeId);
      expect(
        fixture.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM initiative_updates WHERE initiative_id = ?1",
          )
          .get(fixture.initiativeId)?.count,
      ).toBe(1);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });

  it("rejects status deletion after an unrestricted key gains a limit during authorization", () => {
    const fixture = filePlanningFixture(false);
    let writer: SqliteWriter | null = null;
    try {
      const update = createInitiativeUpdate(
        fixture.db,
        fixture.initiativeId,
        fixture.actor.id,
        { body: "status to delete", health: "on_track" },
        fixture.workspaceId,
        fixture.actor,
      );
      const auth = fromPartial<AuthScopeContext>({ keyId: fixture.keyId, teamIds: null });
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "limits-add", fixture.secondaryTeamId);
        },
      };
      expectSqliteBusySnapshot(() =>
        deleteInitiativeUpdate(
          fixture.db,
          update.id,
          fixture.workspaceId,
          fixture.actor,
          auth,
          hooks,
        ),
      );
      const updates = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM initiative_updates WHERE initiative_id = ?1",
        )
        .get(fixture.initiativeId);
      const limits = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
        )
        .get(fixture.keyId);
      expect(updates?.count).toBe(1);
      expect(limits?.count).toBe(1);
      const retryAuth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.secondaryTeamId],
      });
      expectUnauthorized(() =>
        deleteInitiativeUpdate(
          fixture.db,
          update.id,
          fixture.workspaceId,
          fixture.actor,
          retryAuth,
        ),
      );
      expect(
        fixture.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM initiative_updates WHERE initiative_id = ?1",
          )
          .get(fixture.initiativeId)?.count,
      ).toBe(1);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });
  it("rejects dependency creation after a zero-to-one limit change", () => {
    const fixture = filePlanningFixture(false);
    let writer: SqliteWriter | null = null;
    try {
      const auth = fromPartial<AuthScopeContext>({ keyId: fixture.keyId, teamIds: null });
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "limits-add", fixture.secondaryTeamId);
        },
      };
      expectSqliteBusySnapshot(() =>
        createProjectDependency(
          fixture.db,
          { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
          fixture.workspaceId,
          fixture.actor,
          auth,
          hooks,
        ),
      );
      expect(
        fixture.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
          )
          .get(fixture.keyId)?.count,
      ).toBe(1);
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
          .get()?.count,
      ).toBe(0);
      const retryAuth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.secondaryTeamId],
      });
      expectUnauthorized(() =>
        createProjectDependency(
          fixture.db,
          { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
          fixture.workspaceId,
          fixture.actor,
          retryAuth,
        ),
      );
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
          .get()?.count,
      ).toBe(0);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });

  it("allows dependency deletion after a one-to-zero limit change on a fresh scope", () => {
    const fixture = filePlanningFixture(true);
    let writer: SqliteWriter | null = null;
    try {
      const auth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      const dependency = createProjectDependency(
        fixture.db,
        { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
        fixture.workspaceId,
        fixture.actor,
        auth,
      );
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "limits-clear", fixture.secondaryTeamId);
        },
      };
      expectSqliteBusySnapshot(() =>
        deleteProjectDependency(
          fixture.db,
          dependency.id,
          fixture.workspaceId,
          fixture.actor,
          auth,
          hooks,
        ),
      );
      expect(
        fixture.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
          )
          .get(fixture.keyId)?.count,
      ).toBe(0);
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
          .get()?.count,
      ).toBe(1);
      const retryAuth = fromPartial<AuthScopeContext>({ keyId: fixture.keyId, teamIds: null });
      expect(
        deleteProjectDependency(
          fixture.db,
          dependency.id,
          fixture.workspaceId,
          fixture.actor,
          retryAuth,
        ),
      ).toBe(true);
      expect(
        fixture.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
          .get()?.count,
      ).toBe(0);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });
});
