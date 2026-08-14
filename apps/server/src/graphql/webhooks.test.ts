// Tests de AT-139: entregas firmadas (criterio de aceptación 5), filtro por
// evento y reintentos con backoff.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { signPayload } from "../webhooks/dispatcher.ts";
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
    const created = await gql(app, `
      mutation($url: String!) {
        webhookCreate(input: { url: $url, events: ["issue.created", "comment.created"] }) {
          webhook { id events enabled }
          secret
        }
      }
    `, { url: `http://localhost:${receiver.port}/hook` });
    const secret = created.data!.webhookCreate.secret;
    expect(created.data!.webhookCreate.webhook.enabled).toBe(true);

    await gql(app, `mutation { issueCreate(input: { teamKey: "PB", title: "Webhook me" }) { success } }`);
    await gql(app, `mutation { commentCreate(input: { issueId: "PB-1", body: "ping" }) { success } }`);
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

    const all = await gql(app, `
      mutation($url: String!) { webhookCreate(input: { url: $url }) { webhook { id } } }
    `, { url: `http://localhost:${receiver.port}/all` });
    await gql(app, `mutation { issueUpdate(id: "PB-1", input: { priority: 2 }) { success } }`);
    await app.events.idle();
    expect(received.length).toBe(1);
    const payload = JSON.parse(received[0]!.body);
    expect(payload.event).toBe("issue.updated");
    expect(payload.changes.priority).toEqual({ from: 1, to: 2 });

    // Limpieza: borra el webhook catch-all.
    await gql(app, `
      mutation($id: ID!) { webhookDelete(id: $id) { success } }
    `, { id: all.data!.webhookCreate.webhook.id });
  });

  it("reintenta con backoff hasta entregar", async () => {
    received.length = 0;
    attempts = 0;
    failuresLeft = 2;
    await gql(app, `mutation { issueCreate(input: { teamKey: "PB", title: "Retry me" }) { success } }`);
    await app.events.idle();
    expect(attempts).toBe(3);
    expect(received.length).toBe(1);
    expect(JSON.parse(received[0]!.body).event).toBe("issue.created");
  });

  it("valida la URL del webhook", async () => {
    const bad = await gql(app, `mutation { webhookCreate(input: { url: "not-a-url" }) { success } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
