// PRB-545: smoke de Documents contra el backend PostgreSQL real.
import { afterAll, describe, expect, it } from "bun:test";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { migratePostgres } from "../db/postgres/migrator.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { newId, now } from "../db/util.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL Documents", () => {
  let stop: (() => void) | undefined;
  let close: (() => Promise<void>) | undefined;

  afterAll(async () => {
    stop?.();
    await close?.();
  });

  integration("crea, busca, archiva y restaura un Document", async () => {
    const url = process.env.PRIME_BOARD_POSTGRES_URL!;
    const sql = new Bun.SQL(url);
    await migratePostgres(sql);
    const persistence = createPostgresPersistence(sql);
    const db = openDatabase(":memory:");
    const config = {
      port: 0,
      host: "127.0.0.1",
      authMode: "api-key",
      dbPath: ":memory:",
      postgresUrl: url,
      persistenceBackend: "postgres",
      dev: false,
      webDist: "/tmp/prime-board-no-web",
      repoRoot: null,
      bootstrap: resolveBootstrapIdentity({}),
    } as Config;
    const seeded = await bootstrapPostgres(persistence, config.bootstrap);
    const admin = await persistence.one<{ id: string }>(
      "SELECT id FROM actors WHERE name = 'admin'",
    );
    const team = await persistence.one<{ id: string }>("SELECT id FROM teams ORDER BY key LIMIT 1");
    if (!admin || !team) throw new Error("PostgreSQL test requires the bootstrap Workspace");
    const projectId = newId();
    const cycleId = newId();
    const timestamp = now();
    await persistence.execute(
      "INSERT INTO projects (id, name, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      [projectId, "PRB-545 PG project", "planned", timestamp],
    );
    await persistence.execute("INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)", [
      projectId,
      team.id,
    ]);
    await persistence.execute(
      `INSERT INTO cycles (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [cycleId, team.id, 545, "PRB-545 PG cycle", timestamp, timestamp, "upcoming", timestamp],
    );
    const key = seeded.adminApiKey ?? generateApiKey();
    const keyId = newId();
    const limitedKey = generateApiKey();
    const limitedKeyId = newId();
    const memberId = newId();
    const memberKey = generateApiKey();
    const memberKeyId = newId();
    const noTeamInitiativeId = newId();
    const linkedInitiativeId = newId();
    const limitedInitiativeId = newId();
    const limitedTeamId = newId();
    if (!seeded.adminApiKey) {
      await persistence.execute(
        "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)",
        [keyId, admin.id, "documents integration", hashApiKey(key), now()],
      );
      for (const scope of ["read", "write", "admin"]) {
        await persistence.execute(
          "INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)",
          [keyId, scope],
        );
      }
    }
    await persistence.execute(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [limitedKeyId, admin.id, "documents limited integration", hashApiKey(limitedKey), now()],
    );
    for (const scope of ["read", "write"]) {
      await persistence.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
        limitedKeyId,
        scope,
      ]);
    }
    await persistence.execute(
      "INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES ($1, $2)",
      [limitedKeyId, team.id],
    );
    await persistence.execute(
      "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
      [memberId, "PRB-545 member", "agent", timestamp],
    );
    await persistence.execute(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [memberKeyId, memberId, "documents member integration", hashApiKey(memberKey), now()],
    );
    for (const scope of ["read", "write"]) {
      await persistence.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
        memberKeyId,
        scope,
      ]);
    }
    await persistence.execute(
      `INSERT INTO teams (id, name, key, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [limitedTeamId, "PRB-545 limited Team", "LIM", "API key limit fixture", timestamp],
    );
    await persistence.execute(
      `INSERT INTO initiatives (id, name, description, state, created_at, updated_at)
       VALUES ($1, $2, '', 'planned', $3, $3), ($4, $5, '', 'planned', $3, $3),
              ($6, $7, '', 'planned', $3, $3)`,
      [
        noTeamInitiativeId,
        "PRB-545 no-team initiative",
        timestamp,
        linkedInitiativeId,
        "PRB-545 linked initiative",
        limitedInitiativeId,
        "PRB-545 limited initiative",
      ],
    );
    await persistence.execute(
      "INSERT INTO initiative_teams (initiative_id, team_id) VALUES ($1, $2), ($3, $4)",
      [linkedInitiativeId, team.id, limitedInitiativeId, limitedTeamId],
    );
    const app = createApp({ db, config, persistence });
    stop = () => app.server.stop();
    close = async () => {
      await persistence.execute("DELETE FROM api_key_team_limits WHERE api_key_id = $1", [
        limitedKeyId,
      ]);
      await persistence.execute("DELETE FROM api_key_scopes WHERE api_key_id IN ($1, $2)", [
        limitedKeyId,
        memberKeyId,
      ]);
      await persistence.execute("DELETE FROM api_keys WHERE id IN ($1, $2)", [
        limitedKeyId,
        memberKeyId,
      ]);
      await persistence.execute("DELETE FROM actors WHERE id = $1", [memberId]);
      await persistence.execute("DELETE FROM initiative_teams WHERE initiative_id IN ($1, $2)", [
        linkedInitiativeId,
        limitedInitiativeId,
      ]);
      await persistence.execute("DELETE FROM initiatives WHERE id IN ($1, $2, $3)", [
        noTeamInitiativeId,
        linkedInitiativeId,
        limitedInitiativeId,
      ]);
      await persistence.execute("DELETE FROM teams WHERE id = $1", [limitedTeamId]);
      if (!seeded.adminApiKey) {
        await persistence.execute("DELETE FROM api_key_scopes WHERE api_key_id = $1", [keyId]);
        await persistence.execute("DELETE FROM api_keys WHERE id = $1", [keyId]);
      }
      db.close();
      await persistence.close();
    };
    const request = async (query: string, variables?: Record<string, unknown>, token = key) => {
      const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      });
      return (await response.json()) as { data?: any; errors?: Array<{ message: string }> };
    };
    const created = await request(
      `mutation($input: DocumentCreateInput!) {
        documentCreate(input: $input) { document { id title content team { id } } }
      }`,
      {
        input: {
          title: "PRB-545 integration document",
          content: "PostgreSQL worker content",
          teamId: team.id,
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const id = created.data!.documentCreate.document.id as string;
    const projectCreated = await request(
      `mutation($input: DocumentCreateInput!) {
        documentCreate(input: $input) { document { id project { id name teams { id } } } }
      }`,
      { input: { title: "PRB-545 project document", projectId } },
    );
    expect(projectCreated.errors).toBeUndefined();
    expect(projectCreated.data!.documentCreate.document.project).toEqual({
      id: projectId,
      name: "PRB-545 PG project",
      teams: [{ id: team.id }],
    });
    const projectDocumentId = projectCreated.data!.documentCreate.document.id as string;
    const cycleCreated = await request(
      `mutation($input: DocumentCreateInput!) {
        documentCreate(input: $input) { document { id cycle { id number name team { id } progress } } }
      }`,
      { input: { title: "PRB-545 cycle document", cycleId } },
    );
    expect(cycleCreated.errors).toBeUndefined();
    expect(cycleCreated.data!.documentCreate.document.cycle).toEqual({
      id: cycleId,
      number: 545,
      name: "PRB-545 PG cycle",
      team: { id: team.id },
      progress: 0,
    });
    const cycleDocumentId = cycleCreated.data!.documentCreate.document.id as string;
    const globalCreated = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      { input: { title: "PRB-545 global integration document", content: "global content" } },
    );
    expect(globalCreated.errors).toBeUndefined();
    const globalId = globalCreated.data!.documentCreate.document.id as string;
    const noTeamDocument = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id initiative { id } } } }`,
      { input: { title: "PRB-545 no-team document", initiativeId: noTeamInitiativeId } },
      memberKey,
    );
    expect(noTeamDocument.errors).toBeUndefined();
    const noTeamDocumentId = noTeamDocument.data!.documentCreate.document.id as string;
    const linkedDocument = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      { input: { title: "PRB-545 linked initiative document", initiativeId: linkedInitiativeId } },
    );
    expect(linkedDocument.errors).toBeUndefined();
    const linkedDocumentId = linkedDocument.data!.documentCreate.document.id as string;
    const memberLinkedRead = await request(
      `query($id: ID!) { document(id: $id) { id } }`,
      { id: linkedDocumentId },
      memberKey,
    );
    expect(memberLinkedRead.errors).toBeUndefined();
    expect(memberLinkedRead.data!.document).toBeNull();
    const memberLinkedCreate = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      { input: { title: "PRB-545 denied initiative document", initiativeId: linkedInitiativeId } },
      memberKey,
    );
    expect(memberLinkedCreate.errors?.[0]?.message).toContain("Initiative not found");
    const limitedInitiativeCreate = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      {
        input: { title: "PRB-545 limited initiative document", initiativeId: limitedInitiativeId },
      },
      limitedKey,
    );
    expect(limitedInitiativeCreate.errors?.[0]?.message).toContain(
      "API key is limited to different Teams",
    );
    await persistence.execute("UPDATE teams SET archived_at = $1 WHERE id = $2", [
      timestamp,
      team.id,
    ]);
    const archivedInitiativeCreate = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      {
        input: { title: "PRB-545 archived initiative document", initiativeId: linkedInitiativeId },
      },
    );
    expect(archivedInitiativeCreate.errors?.[0]?.message).toContain("Team is archived");
    await persistence.execute("UPDATE teams SET archived_at = NULL WHERE id = $1", [team.id]);
    const limitedCreate = await request(
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
      { input: { title: "PRB-545 denied global document", content: "denied" } },
      limitedKey,
    );
    expect(limitedCreate.errors?.[0]?.message).toContain("unrestricted API key");
    const limitedList = await request(`{ documents { id title } }`, undefined, limitedKey);
    expect(limitedList.errors).toBeUndefined();
    expect(limitedList.data!.documents).toContainEqual({
      id,
      title: "PRB-545 integration document",
    });
    expect(limitedList.data!.documents).not.toContainEqual({
      id: globalId,
      title: "PRB-545 global integration document",
    });
    const listed = await request(`{ documents(search: "work") { id title content } }`);
    expect(listed.errors).toBeUndefined();
    expect(listed.data!.documents).toContainEqual({
      id,
      title: "PRB-545 integration document",
      content: "PostgreSQL worker content",
    });
    const archived = await request(
      `mutation($id: ID!) { documentArchive(id: $id) { document { archivedAt } } }`,
      { id },
    );
    expect(archived.errors).toBeUndefined();
    expect(archived.data!.documentArchive.document.archivedAt).toEqual(expect.any(String));
    const restored = await request(
      `mutation($id: ID!) { documentUnarchive(id: $id) { document { archivedAt } } }`,
      { id },
    );
    expect(restored.errors).toBeUndefined();
    expect(restored.data!.documentUnarchive.document.archivedAt).toBeNull();
    await persistence.execute("DELETE FROM documents WHERE id IN ($1, $2, $3, $4, $5, $6)", [
      id,
      globalId,
      projectDocumentId,
      cycleDocumentId,
      noTeamDocumentId,
      linkedDocumentId,
    ]);
    await persistence.execute("DELETE FROM project_teams WHERE project_id = $1", [projectId]);
    await persistence.execute("DELETE FROM projects WHERE id = $1", [projectId]);
    await persistence.execute("DELETE FROM cycles WHERE id = $1", [cycleId]);
  });
});
