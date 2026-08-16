// PRB-215: solo el dueño puede editar/borrar una iniciativa.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("initiative ownership", () => {
  it("otro actor no puede actualizar ni borrar la iniciativa ajena", async () => {
    const created = await gql(
      app,
      `mutation {
        initiativeCreate(input: { name: "Owned", state: ACTIVE }) {
          initiative { id owner { name } }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data!.initiativeCreate.initiative.owner.name).toBe("admin");
    const id = created.data!.initiativeCreate.initiative.id;

    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "init-agent", type: AGENT }) { actor { id } } }`,
    );
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "k" }) { key }
        }`,
        { actorId: agent.data!.actorCreate.actor.id },
      )
    ).data!.apiKeyCreate.key;

    const listed = await gql(app, `{ initiatives { id name } }`, {}, key);
    expect(listed.data!.initiatives.some((i: { id: string }) => i.id === id)).toBe(true);

    const update = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { name: "Hijacked" }) { success }
      }`,
      { id },
      key,
    );
    expect(update.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const del = await gql(
      app,
      `mutation($id: ID!) { initiativeDelete(id: $id) { success } }`,
      { id },
      key,
    );
    expect(del.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
