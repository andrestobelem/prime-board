// Tests de AT-136: comentarios con autoría real y historial que reconstruye
// la secuencia completa de cambios (criterio de aceptación 7).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let agentKey: string;

beforeAll(async () => {
  app = createTestApp();
  // Alta de un agente con su propia key para verificar autoría.
  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "worker-bot", type: AGENT }) { actor { id } } }`,
  );
  const key = await gql(
    app,
    `
    mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "k" }) { key } }
  `,
    { actorId: actor.data!.actorCreate.actor.id },
  );
  agentKey = key.data!.apiKeyCreate.key;
  await gql(
    app,
    `mutation { issueCreate(input: { teamKey: "PB", title: "Ship it" }) { issue { id } } }`,
  );
});
afterAll(() => app.stop());

describe("comments", () => {
  it("comenta por identificador legible con autoría del agente", async () => {
    const result = await gql(
      app,
      `
      mutation {
        commentCreate(input: { issueId: "PB-1", body: "On it. **ETA 5m**" }) {
          comment { body actor { name type } issue { identifier } }
        }
      }
    `,
      {},
      agentKey,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.commentCreate.comment.actor).toEqual({ name: "worker-bot", type: "AGENT" });
    expect(result.data!.commentCreate.comment.issue.identifier).toBe("PB-1");
  });

  it("rechaza cuerpos vacíos e issues inexistentes", async () => {
    const empty = await gql(
      app,
      `mutation { commentCreate(input: { issueId: "PB-1", body: "  " }) { success } }`,
    );
    expect(empty.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const missing = await gql(
      app,
      `mutation { commentCreate(input: { issueId: "PB-99", body: "x" }) { success } }`,
    );
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("activity", () => {
  it("reconstruye la secuencia completa de cambios", async () => {
    // Genera cambios: estado → assignee → comentario (ya hubo created y commented).
    const team = await gql(app, `{ team(key: "PB") { states { id type name } } }`);
    const startedState = team.data!.team.states.find((s: any) => s.type === "STARTED");
    const started = startedState.id;
    const viewer = await gql(app, `{ viewer { id } }`);
    await gql(
      app,
      `
      mutation($stateId: ID!, $assigneeId: ID!) {
        issueUpdate(id: "PB-1", input: { stateId: $stateId, assigneeId: $assigneeId }) { success }
      }
    `,
      { stateId: started, assigneeId: viewer.data!.viewer.id },
    );

    const result = await gql(
      app,
      `
      { issue(id: "PB-1") { activity { type actor { name } payload } comments { body } } }
    `,
    );
    const activity = result.data!.issue.activity;
    expect(activity.map((a: any) => a.type)).toEqual([
      "created",
      "commented",
      "state_changed",
      "assigned",
    ]);
    expect(activity[0].actor.name).toBe("admin");
    expect(activity[1].actor.name).toBe("worker-bot");
    // AT-190: el payload de Activity llega con nombres reales, no ids —
    // tanto para states (state_changed) como para actors (assigned).
    expect(activity[2].payload.to).toBe(startedState.name);
    expect(activity[3].payload.to).toBe("admin");
    expect(result.data!.issue.comments.length).toBe(1);
  });
});
