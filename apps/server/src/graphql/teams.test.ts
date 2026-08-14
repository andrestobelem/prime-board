// Tests de AT-133: teams con workflow default, actores agente y API keys por GraphQL.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("teams", () => {
  it("crea un team y siembra el workflow default", async () => {
    const result = await gql(app, `
      mutation {
        teamCreate(input: { name: "Agents", key: "ag" }) {
          success
          team { key name states { name type } }
        }
      }
    `);
    expect(result.errors).toBeUndefined();
    const team = result.data!.teamCreate.team;
    expect(team.key).toBe("AG");
    expect(team.states.map((s: any) => s.type)).toEqual([
      "BACKLOG", "UNSTARTED", "STARTED", "COMPLETED", "CANCELED",
    ]);
  });

  it("busca team por key y agrega estados custom", async () => {
    const found = await gql(app, `{ team(key: "AG") { id name } }`);
    expect(found.data!.team.name).toBe("Agents");

    const state = await gql(app, `
      mutation($teamId: ID!) {
        workflowStateCreate(input: { teamId: $teamId, name: "Ready for Agent", type: UNSTARTED }) {
          workflowState { name type position }
        }
      }
    `, { teamId: found.data!.team.id });
    expect(state.data!.workflowStateCreate.workflowState).toMatchObject({
      name: "Ready for Agent",
      type: "UNSTARTED",
    });
  });

  it("rechaza keys de team inválidas o duplicadas", async () => {
    const bad = await gql(app, `mutation { teamCreate(input: { name: "X", key: "123!" }) { success } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const dup = await gql(app, `mutation { teamCreate(input: { name: "X", key: "AG" }) { success } }`);
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});

describe("actores y API keys", () => {
  it("da de alta un agente con su key y el agente opera como viewer", async () => {
    const created = await gql(app, `
      mutation {
        actorCreate(input: { name: "prime-agent", type: AGENT }) {
          actor { id name type }
        }
      }
    `);
    const agent = created.data!.actorCreate.actor;
    expect(agent.type).toBe("AGENT");

    const keyResult = await gql(app, `
      mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "agent key" }) {
          key
          apiKey { name actor { name } }
        }
      }
    `, { actorId: agent.id });
    const plaintext = keyResult.data!.apiKeyCreate.key;
    expect(plaintext).toStartWith("pb_");

    // Round-trip: el agente usa su propia key.
    const asAgent = await gql(app, "{ viewer { name type } }", {}, plaintext);
    expect(asAgent.data!.viewer).toEqual({ name: "prime-agent", type: "AGENT" });
  });

  it("apiKeyCreate falla con actor inexistente", async () => {
    const result = await gql(app, `
      mutation { apiKeyCreate(input: { actorId: "nope", name: "x" }) { key } }
    `);
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("lista actores filtrando por tipo", async () => {
    const result = await gql(app, `{ actors(type: AGENT) { name type } }`);
    expect(result.data!.actors).toEqual([{ name: "prime-agent", type: "AGENT" }]);
  });
});
