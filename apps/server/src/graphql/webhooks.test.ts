// Tests de AT-139: entregas firmadas (criterio de aceptación 5), filtro por
// evento y reintentos con backoff.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { signPayload } from "../webhooks/dispatcher.ts";
import { WEBHOOK_EVENT_NAMES } from "../webhooks/events.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

interface Received {
  signature: string;
  body: string;
}

let app: TestApp;
let receiver: ReturnType<typeof Bun.serve>;
const received: Received[] = [];
let failuresLeft = 0;
let attempts = 0;

beforeAll(async () => {
  app = createTestApp();
  receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      attempts += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response("boom", { status: 500 });
      }
      received.push({
        signature: request.headers.get("x-primeboard-signature") ?? "",
        body: await request.text(),
      });
      return new Response("ok");
    },
  });
});
afterAll(() => {
  receiver.stop(true);
  app.stop();
});

describe("webhooks", () => {
  it("entrega issue.created y comment.created firmados (criterio 5)", async () => {
    const created = await gql(
      app,
      `
      mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["issue.created", "comment.created"] }) {
          webhook { id events enabled }
          secret
        }
      }
    `,
      { url: `http://localhost:${receiver.port}/hook` },
    );
    const secret = created.data!.webhookCreate.secret;
    expect(created.data!.webhookCreate.webhook.enabled).toBe(true);

    await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Webhook me" }) { success } }`,
    );
    await gql(
      app,
      `mutation { commentCreate(input: { issueId: "PB-1", body: "ping" }) { success } }`,
    );
    await app.events.idle();

    expect(received.length).toBe(2);
    const first = JSON.parse(received[0]!.body);
    expect(first.event).toBe("issue.created");
    expect(first.actor.name).toBe("admin");
    expect(first.data.identifier).toBe("PB-1");
    const second = JSON.parse(received[1]!.body);
    expect(second.event).toBe("comment.created");
    expect(second.data.issueIdentifier).toBe("PB-1");

    // Firma HMAC-SHA256 verificable con el secret devuelto al crear.
    for (const delivery of received) {
      expect(delivery.signature).toBe(signPayload(secret, delivery.body));
    }
  });

  it("no entrega eventos no suscriptos pero sí issue.updated con changes", async () => {
    received.length = 0;
    // El webhook existente NO está suscripto a issue.updated.
    await gql(app, `mutation { issueUpdate(id: "PB-1", input: { priority: 1 }) { success } }`);
    await app.events.idle();
    expect(received.length).toBe(0);

    const all = await gql(
      app,
      `
      mutation($url: String!) { webhookCreate(input: { url: $url }) { webhook { id } } }
    `,
      { url: `http://localhost:${receiver.port}/all` },
    );
    await gql(app, `mutation { issueUpdate(id: "PB-1", input: { priority: 2 }) { success } }`);
    await app.events.idle();
    expect(received.length).toBe(1);
    const payload = JSON.parse(received[0]!.body);
    expect(payload.event).toBe("issue.updated");
    expect(payload.changes.priority).toEqual({ from: 1, to: 2 });

    // Limpieza: borra el webhook catch-all.
    await gql(
      app,
      `
      mutation($id: ID!) { webhookDelete(id: $id) { success } }
    `,
      { id: all.data!.webhookCreate.webhook.id },
    );
  });

  it("entrega issue.updated al borrar una relación en ambos extremos", async () => {
    received.length = 0;
    const hook = await gql(
      app,
      `mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["issue.updated"] }) { webhook { id } }
      }`,
      { url: `http://localhost:${receiver.port}/relations` },
    );
    const first = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Relation source" }) {
        issue { id identifier }
      } }`,
    );
    const second = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Relation target" }) {
        issue { id identifier }
      } }`,
    );
    const source = first.data!.issueCreate.issue;
    const target = second.data!.issueCreate.issue;
    received.length = 0;
    const relation = await gql(
      app,
      `mutation($source: ID!, $target: ID!) {
        issueRelationCreate(input: { issueId: $source, relatedIssueId: $target, type: RELATED }) {
          relation { id }
        }
      }`,
      { source: source.id, target: target.id },
    );
    await app.events.idle();
    expect(received).toHaveLength(2);
    const createdPayloads = received.map((delivery) => JSON.parse(delivery.body));
    expect(createdPayloads.map((payload) => payload.data.identifier).sort()).toEqual(
      [source.identifier, target.identifier].sort(),
    );
    received.length = 0;

    await gql(app, `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`, {
      id: relation.data!.issueRelationCreate.relation.id,
    });
    await app.events.idle();

    expect(received).toHaveLength(2);
    const payloads = received.map((delivery) => JSON.parse(delivery.body));
    expect(payloads.map((payload) => payload.event)).toEqual(["issue.updated", "issue.updated"]);
    expect(payloads.map((payload) => payload.data.identifier).sort()).toEqual(
      [source.identifier, target.identifier].sort(),
    );
    for (const payload of payloads) {
      expect(payload.changes.relations.from).toMatchObject({ type: "related" });
      expect(payload.changes.relations.to).toBeNull();
    }

    await gql(app, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, {
      id: hook.data!.webhookCreate.webhook.id,
    });
  });

  it("entrega issue.updated al borrar un label usado por issues", async () => {
    received.length = 0;
    const hook = await gql(
      app,
      `mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["issue.updated"] }) { webhook { id } }
      }`,
      { url: `http://localhost:${receiver.port}/label-delete` },
    );
    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "Webhook deleted label" }) { label { id } } }`,
    );
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Webhook label issue" }) { issue { id identifier } } }`,
    );
    await gql(
      app,
      `mutation($id: ID!, $label: ID!) { issueUpdate(id: $id, input: { labelIds: [$label] }) { success } }`,
      { id: issue.data!.issueCreate.issue.id, label: label.data!.labelCreate.label.id },
    );
    await app.events.idle();
    received.length = 0;
    await gql(app, `mutation($id: ID!) { labelDelete(id: $id) { success } }`, {
      id: label.data!.labelCreate.label.id,
    });
    await app.events.idle();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body).data.identifier).toBe(
      issue.data!.issueCreate.issue.identifier,
    );
    await gql(app, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, {
      id: hook.data!.webhookCreate.webhook.id,
    });
  });

  it("reintenta con backoff hasta entregar", async () => {
    received.length = 0;
    attempts = 0;
    failuresLeft = 2;
    await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Retry me" }) { success } }`,
    );
    await app.events.idle();
    expect(attempts).toBe(3);
    expect(received.length).toBe(1);
    expect(JSON.parse(received[0]!.body).event).toBe("issue.created");
  });

  it("rechaza eventos desconocidos y acepta todos los eventos soportados", async () => {
    const before = await gql(app, `{ webhooks { id } }`);
    const bad = await gql(
      app,
      `mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["issue.unknown"] }) { success }
      }`,
      { url: `http://localhost:${receiver.port}/invalid-event` },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const after = await gql(app, `{ webhooks { id } }`);
    expect(after.data!.webhooks).toHaveLength(before.data!.webhooks.length);

    const created = await gql(
      app,
      `mutation($url: String!, $events: [String!]) {
        webhookCreate(input: { url: $url, events: $events }) { webhook { id events } }
      }`,
      { url: `http://localhost:${receiver.port}/all-supported`, events: [...WEBHOOK_EVENT_NAMES] },
    );
    expect(created.data!.webhookCreate.webhook.events).toEqual([...WEBHOOK_EVENT_NAMES]);
    await gql(app, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, {
      id: created.data!.webhookCreate.webhook.id,
    });
  });

  it("entrega team.deleted aunque el Team ya no exista al despachar", async () => {
    received.length = 0;
    const team = await gql(
      app,
      `mutation { teamCreate(input: { name: "Deletion event", key: "del" }) { team { id } } }`,
    );
    const webhook = await gql(
      app,
      `mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["team.deleted"] }) {
          webhook { id }
        }
      }`,
      { url: `http://localhost:${receiver.port}/team-deleted` },
    );
    expect(webhook.errors).toBeUndefined();
    await gql(app, `mutation($id: ID!) { teamDelete(id: $id, confirmation: "DEL") { success } }`, {
      id: team.data!.teamCreate.team.id,
    });
    await app.events.idle();
    const deletion = received
      .map((item) => JSON.parse(item.body))
      .find((body) => body.event === "team.deleted");
    expect(deletion).toBeDefined();
    expect(deletion.data._teamOwnerIds).toBeUndefined();
    expect(deletion.data.teamId).toBe(team.data!.teamCreate.team.id);
  });

  it("valida la URL del webhook", async () => {
    const bad = await gql(
      app,
      `mutation { webhookCreate(input: { url: "not-a-url" }) { success } }`,
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
