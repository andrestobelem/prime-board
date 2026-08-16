// PRB-235: autorización explícita del roster y las API keys.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { openDatabase } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("actor management authorization", () => {
  it("exposes the workspace role and lets an admin manage actors", async () => {
    const viewer = await gql(app, `{ viewer { name workspaceRole } }`);
    expect(viewer.errors).toBeUndefined();
    expect(viewer.data!.viewer).toEqual({ name: "admin", workspaceRole: "ADMIN" });

    const created = await gql(
      app,
      `mutation { actorCreate(input: { name: "managed-agent", type: AGENT }) { actor { id workspaceRole } } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data!.actorCreate.actor.workspaceRole).toBe("MEMBER");
  });

  it("limits member mutations to the member's own actor and keys", async () => {
    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "self-managing-agent", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id;
    const other = await gql(
      app,
      `mutation { actorCreate(input: { name: "other-agent", type: AGENT }) { actor { id } } }`,
    );
    const otherId = other.data!.actorCreate.actor.id;
    const memberKey = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "member login" }) { key } }`,
      { actorId: memberId },
    );
    const otherKey = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "other login" }) { key } }`,
      { actorId: otherId },
    );
    const key = memberKey.data!.apiKeyCreate.key;
    const otherKeyId = (await gql(app, `{ actors { id apiKeys { id name } } }`)).data!.actors.find(
      (actor: { id: string }) => actor.id === otherId,
    ).apiKeys[0].id;

    const createDenied = await gql(
      app,
      `mutation { actorCreate(input: { name: "rogue-agent", type: AGENT }) { success } }`,
      {},
      key,
    );
    expect(createDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const ownUpdate = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { name: "self-renamed" }) { actor { id name } } }`,
      { id: memberId },
      key,
    );
    expect(ownUpdate.errors).toBeUndefined();
    expect(ownUpdate.data!.actorUpdate.actor.name).toBe("self-renamed");

    const otherUpdate = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { name: "stolen-name" }) { success } }`,
      { id: otherId },
      key,
    );
    expect(otherUpdate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const ownKey = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "second key" }) { key apiKey { id } } }`,
      { actorId: memberId },
      key,
    );
    expect(ownKey.errors).toBeUndefined();

    const otherKeyCreate = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "stolen key" }) { key } }`,
      { actorId: otherId },
      key,
    );
    expect(otherKeyCreate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const otherKeyDelete = await gql(
      app,
      `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
      { id: otherKeyId },
      key,
    );
    expect(otherKeyDelete.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const ownKeyId = ownKey.data!.apiKeyCreate.apiKey.id;
    const ownKeyDelete = await gql(
      app,
      `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
      { id: ownKeyId },
      key,
    );
    expect(ownKeyDelete.errors).toBeUndefined();
    expect(ownKeyDelete.data!.apiKeyDelete.success).toBe(true);

    const listed = await gql(app, `{ actors { id apiKeys { name } } }`, {}, key);
    const listedOther = listed.data!.actors.find((actor: { id: string }) => actor.id === otherId);
    expect(listedOther.apiKeys).toEqual([]);
  });

  it("preserves workspace roles through export and rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-actor-roles-"));
    const rebuilt = openDatabase(":memory:");
    try {
      exportBoard(app.db, dir);
      const actors = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "actors.json"), "utf8"),
      ) as Array<{ name: string; workspaceRole: string }>;
      expect(actors.find((actor) => actor.name === "admin")?.workspaceRole).toBe("admin");
      expect(actors.find((actor) => actor.name === "other-agent")?.workspaceRole).toBe("member");

      rebuildFromRepo(rebuilt, dir);
      const roleRows = rebuilt
        .query("SELECT name, workspace_role FROM actors ORDER BY name")
        .all() as Array<{ name: string; workspace_role: string }>;
      expect(roleRows.find((actor) => actor.name === "admin")?.workspace_role).toBe("admin");
      expect(roleRows.find((actor) => actor.name === "other-agent")?.workspace_role).toBe("member");
    } finally {
      rebuilt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
