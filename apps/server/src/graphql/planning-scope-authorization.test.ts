import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  createProject,
  createProjectDependency,
  deleteProjectDependency,
} from "../domain/projects.ts";
import { createInitiativeUpdate, deleteInitiativeUpdate } from "../domain/initiatives.ts";
import type { ActorRow, AuthScopeContext, PlanningAuthorizationHooks } from "../auth/viewer.ts";
import { createApiKey } from "../domain/actors.ts";
import { createTeam } from "../domain/teams.ts";
import { bootstrap } from "../db/seed.ts";
import { migrate } from "../db/database.ts";
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
}

function filePlanningFixture(limitedToPrimary: boolean): FilePlanningFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "prb-planning-scope-"));
  const dbPath = join(rootDir, "board.sqlite");
  const db = new Database(dbPath, { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
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
  };
}

function waitForBarrier(path: string): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (existsSync(`${path}.error`)) throw new Error(`Concurrent writer failed: ${path}`);
    if (Date.now() > deadline) throw new Error(`Concurrent writer timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function waitForOneOf(paths: readonly string[]): string {
  const deadline = Date.now() + 10_000;
  while (true) {
    const found = paths.find((path) => existsSync(path));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Concurrent writer timed out: ${paths.join(", ")}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

interface SqliteWriter {
  waitReady(): void;
  begin(): void;
  release(): void;
  waitBlocked(): void;
  waitDone(): void;
  waitDoneOrBlocked(): void;
  stop(): void;
}

function startSqliteWriter(
  fixture: FilePlanningFixture,
  mode: "limits-add" | "limits-clear" | "project-team-change",
): SqliteWriter {
  const barrierDir = join(fixture.rootDir, `${mode}-${Date.now()}-${Math.random()}`);
  mkdirSync(barrierDir, { recursive: true });
  const workerPath = join(barrierDir, "writer.ts");
  const workerSource = [
    'import { Database } from "bun:sqlite";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const [dbPath, barrierDir, mode, workspaceId, keyId, teamId, projectId, secondaryTeamId] = process.argv.slice(2);",
    "const ready = join(barrierDir, 'ready');",
    "const start = join(barrierDir, 'start');",
    "const attempted = join(barrierDir, 'attempted');",
    "const blocked = join(barrierDir, 'blocked');",
    "const release = join(barrierDir, 'release');",
    "const done = join(barrierDir, 'done');",
    "const failed = join(barrierDir, 'failed');",
    "const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
    "const waitFor = (path) => { while (!existsSync(path)) wait(); };",
    "const db = new Database(dbPath, { strict: true });",
    "db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;');",
    "writeFileSync(ready, 'ready');",
    "waitFor(start);",
    "writeFileSync(attempted, 'attempted');",
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
    "  writeFileSync(done, 'done');",
    "} catch (error) {",
    "  writeFileSync(blocked, error instanceof Error ? error.message : String(error));",
    "  waitFor(release);",
    "  try { mutate(); writeFileSync(done, 'done'); }",
    "  catch (retryError) { writeFileSync(failed, retryError instanceof Error ? retryError.message : String(retryError)); }",
    "}",
    "db.close();",
  ].join("\n");
  writeFileSync(workerPath, workerSource);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      workerPath,
      fixture.dbPath,
      barrierDir,
      mode,
      fixture.workspaceId,
      fixture.keyId,
      fixture.primaryTeamId,
      fixture.targetId,
      fixture.secondaryTeamId,
    ],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  const path = (name: string) => join(barrierDir, name);
  return {
    waitReady: () => waitForBarrier(path("ready")),
    begin: () => writeFileSync(path("start"), "start"),
    release: () => writeFileSync(path("release"), "release"),
    waitBlocked: () => waitForBarrier(path("blocked")),
    waitDone: () => {
      waitForBarrier(path("done"));
      if (existsSync(path("failed"))) throw new Error("Concurrent writer retry failed");
    },
    waitDoneOrBlocked: () => {
      const outcome = waitForOneOf([path("done"), path("blocked")]);
      if (outcome === path("blocked")) {
        writeFileSync(path("release"), "release");
        waitForBarrier(path("done"));
      }
      if (existsSync(path("failed"))) throw new Error("Concurrent writer retry failed");
    },
    stop: () => {
      if (child.exitCode === null) child.kill();
      rmSync(barrierDir, { recursive: true, force: true });
    },
  };
}

function startWriterDuringTransaction(
  fixture: FilePlanningFixture,
  mode: "limits-add" | "limits-clear" | "project-team-change",
  waitForCommit: boolean,
): SqliteWriter {
  const writer = startSqliteWriter(fixture, mode);
  writer.waitReady();
  writer.begin();
  if (waitForCommit) writer.waitDoneOrBlocked();
  else writer.waitBlocked();
  return writer;
}

function closeFilePlanningFixture(fixture: FilePlanningFixture): void {
  fixture.db.close();
  rmSync(fixture.rootDir, { recursive: true, force: true });
}

function stopWriter(writer: SqliteWriter | null): void {
  writer?.stop();
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
  it("serializes a project Team change that starts during authorization", () => {
    const fixture = filePlanningFixture(true);
    let writer: SqliteWriter | null = null;
    try {
      const auth = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      const hooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "project-team-change", false);
        },
      };
      const dependency = createProjectDependency(
        fixture.db,
        { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
        fixture.workspaceId,
        fixture.actor,
        auth,
        hooks,
      );
      expect(dependency.project_id).toBe(fixture.sourceId);
      writer!.release();
      writer!.waitDone();
      const dependencies = fixture.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
        .get();
      const targetTeams = fixture.db
        .query<{ team_id: string }, [string]>(
          "SELECT team_id FROM project_teams WHERE project_id = ?1",
        )
        .all(fixture.targetId);
      expect(dependencies?.count).toBe(1);
      expect(targetTeams.map((row) => row.team_id)).toEqual([fixture.secondaryTeamId]);
    } finally {
      stopWriter(writer);
      closeFilePlanningFixture(fixture);
    }
  });

  it("serializes zero-to-one and one-to-zero key limits around a mutation", () => {
    const fixture = filePlanningFixture(false);
    let writer: SqliteWriter | null = null;
    let secondWriter: SqliteWriter | null = null;
    try {
      const unrestricted = fromPartial<AuthScopeContext>({ keyId: fixture.keyId, teamIds: null });
      const addHooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          writer = startWriterDuringTransaction(fixture, "limits-add", false);
        },
      };
      const dependency = createProjectDependency(
        fixture.db,
        { projectId: fixture.sourceId, dependsOnProjectId: fixture.targetId },
        fixture.workspaceId,
        fixture.actor,
        unrestricted,
        addHooks,
      );
      expect(dependency.project_id).toBe(fixture.sourceId);
      writer!.release();
      writer!.waitDone();
      const addedLimits = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
        )
        .get(fixture.keyId);
      expect(addedLimits?.count).toBe(1);

      const limited = fromPartial<AuthScopeContext>({
        keyId: fixture.keyId,
        teamIds: [fixture.primaryTeamId],
      });
      const clearHooks: PlanningAuthorizationHooks = {
        afterAuthorization: () => {
          secondWriter = startWriterDuringTransaction(fixture, "limits-clear", false);
        },
      };
      expect(
        deleteProjectDependency(
          fixture.db,
          dependency.id,
          fixture.workspaceId,
          fixture.actor,
          limited,
          clearHooks,
        ),
      ).toBe(true);
      secondWriter!.release();
      secondWriter!.waitDone();
      const remainingDependencies = fixture.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM project_dependencies")
        .get();
      const clearedLimits = fixture.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM api_key_team_limits WHERE api_key_id = ?1",
        )
        .get(fixture.keyId);
      expect(remainingDependencies?.count).toBe(0);
      expect(clearedLimits?.count).toBe(0);
    } finally {
      stopWriter(writer);
      stopWriter(secondWriter);
      closeFilePlanningFixture(fixture);
    }
  });
});
