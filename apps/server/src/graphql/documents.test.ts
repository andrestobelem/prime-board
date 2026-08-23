// PRB-541: documentos Markdown vinculables y buscables.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { newId, now } from "../db/util.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("documents", () => {
  it("crea un documento para un issue y lo expone desde ambos recursos", async () => {
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Documented issue" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const created = await gql(
      app,
      `mutation($input: DocumentCreateInput!) {
        documentCreate(input: $input) {
          success
          document { id title content issue { id } creator { name } url }
        }
      }`,
      { input: { title: "Implementation spec", content: "# Plan\n\n- Ship it", issueId } },
    );
    expect(created.errors).toBeUndefined();
    const document = created.data!.documentCreate.document;
    expect(document).toMatchObject({
      title: "Implementation spec",
      content: "# Plan\n\n- Ship it",
      issue: { id: issueId },
      creator: { name: "admin" },
    });
    expect(document.url).toBe(`${app.url}/document/${document.id}`);

    const issueDocuments = await gql(
      app,
      `query($id: ID!) { issue(id: $id) { documents { id title } } }`,
      { id: issueId },
    );
    expect(issueDocuments.data!.issue.documents).toEqual([
      { id: document.id, title: document.title },
    ]);
  });

  it("rechaza un documento de una iniciativa vinculada a un Team archivado", async () => {
    const isolated = createTestApp();
    try {
      const team = isolated.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as {
        id: string;
      };
      const initiative = await gql(
        isolated,
        `mutation($teamId: ID!) { initiativeCreate(input: { name: "Archived Team initiative", teamIds: [$teamId] }) { initiative { id } } }`,
        { teamId: team.id },
      );
      const initiativeId = initiative.data!.initiativeCreate.initiative.id as string;
      isolated.db.query("UPDATE teams SET archived_at = ?1 WHERE id = ?2").run(now(), team.id);

      const result = await gql(
        isolated,
        `mutation($initiativeId: ID!) { documentCreate(input: { title: "Must fail", initiativeId: $initiativeId }) { document { id } } }`,
        { initiativeId },
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      expect(result.errors?.[0]?.message).toContain("Team is archived");
    } finally {
      isolated.stop();
    }
  });

  it("permite documentos globales, búsqueda y archivo reversible", async () => {
    const created = await gql(
      app,
      `mutation { documentCreate(input: { title: "Runbook", content: "Restart worker safely" }) { document { id } } }`,
    );
    const id = created.data!.documentCreate.document.id;
    const search = await gql(app, `query { documents(search: "worker") { title content } }`);
    expect(search.data!.documents).toEqual([
      { title: "Runbook", content: "Restart worker safely" },
    ]);

    const archived = await gql(
      app,
      `mutation($id: ID!) { documentArchive(id: $id) { document { archivedAt } } }`,
      { id },
    );
    expect(archived.data!.documentArchive.document.archivedAt).toEqual(expect.any(String));
    const active = await gql(app, `query { documents(search: "worker") { id } }`);
    expect(active.data!.documents).toEqual([]);
    const restored = await gql(
      app,
      `mutation($id: ID!) { documentUnarchive(id: $id) { document { archivedAt } } }`,
      { id },
    );
    expect(restored.data!.documentUnarchive.document.archivedAt).toBeNull();

    const team = app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string };
    const teamDocument = await gql(
      app,
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id title } } }`,
      {
        input: { title: "Team-limited document", content: "Visible to the Team", teamId: team.id },
      },
    );
    const limitedKey = generateApiKey();
    const limitedKeyId = newId();
    const admin = app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as {
      id: string;
    };
    app.db
      .query(
        "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(limitedKeyId, admin.id, "limited document test", hashApiKey(limitedKey), now());
    app.db
      .query("INSERT INTO api_key_scopes (api_key_id, scope) VALUES (?1, 'read')")
      .run(limitedKeyId);
    app.db
      .query("INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES (?1, ?2)")
      .run(limitedKeyId, team.id);
    const limitedList = await gql(app, `query { documents { id title } }`, {}, limitedKey);
    expect(limitedList.errors).toBeUndefined();
    expect(limitedList.data!.documents).toContainEqual(teamDocument.data!.documentCreate.document);
    expect(limitedList.data!.documents).not.toContainEqual({ id, title: "Runbook" });
    app.db.query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1").run(limitedKeyId);
    app.db.query("DELETE FROM api_key_scopes WHERE api_key_id = ?1").run(limitedKeyId);
    app.db.query("DELETE FROM api_keys WHERE id = ?1").run(limitedKeyId);
  });

  it("rechaza más de un recurso y actualiza Markdown", async () => {
    const bad = await gql(
      app,
      `mutation { documentCreate(input: { title: "Invalid", issueId: "missing", projectId: "missing" }) { success } }`,
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const created = await gql(
      app,
      `mutation { documentCreate(input: { title: "Editable" }) { document { id } } }`,
    );
    const id = created.data!.documentCreate.document.id;
    const updated = await gql(
      app,
      `mutation($id: ID!) { documentUpdate(id: $id, input: { title: "Edited", content: "## Details" }) { document { title content } } }`,
      { id },
    );
    expect(updated.data!.documentUpdate.document).toEqual({
      title: "Edited",
      content: "## Details",
    });
  });
});
