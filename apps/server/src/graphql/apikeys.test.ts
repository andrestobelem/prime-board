// Tests de AT-151 (backend): listar y revocar API keys por actor.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("api keys", () => {
  it("lista las keys de un actor sin exponer el hash y las revoca", async () => {
    const actor = await gql(app, `mutation { actorCreate(input: { name: "bot", type: AGENT }) { actor { id } } }`);
    const actorId = actor.data!.actorCreate.actor.id;
    const created = await gql(app, `
      mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "k1" }) { key apiKey { id } } }
    `, { actorId });
    const plaintext = created.data!.apiKeyCreate.key;
    const keyId = created.data!.apiKeyCreate.apiKey.id;

    const listed = await gql(app, `{ actors(type: AGENT) { name apiKeys { id name lastUsedAt } } }`);
    expect(listed.data!.actors[0].apiKeys.map((k: any) => k.name)).toEqual(["k1"]);

    // la key funciona...
    const asBot = await gql(app, "{ viewer { name } }", {}, plaintext);
    expect(asBot.data!.viewer.name).toBe("bot");

    // ...y tras revocarla deja de funcionar
    const deleted = await gql(app, `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`, { id: keyId });
    expect(deleted.data!.apiKeyDelete.success).toBe(true);
    const rejected = await gql(app, "{ viewer { name } }", {}, plaintext);
    expect(rejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("apiKeyDelete con id inexistente devuelve NOT_FOUND", async () => {
    const result = await gql(app, `mutation { apiKeyDelete(id: "nope") { success } }`);
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
