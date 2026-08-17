// PRB-264: webhooks privados por actor, con bypass del admin.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("autorización de webhooks", () => {
  it("limita la lectura y baja al owner, y permite al admin administrar todos", async () => {
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "webhook-owner", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "webhook owner key" }) { key }
      }`,
      { actorId },
    );
    const ownerKey = keyResult.data!.apiKeyCreate.key as string;

    const adminCreated = await gql(
      app,
      `mutation { webhookCreate(input: { url: "https://example.com/admin" }) { webhook { id } } }`,
    );
    expect(adminCreated.errors).toBeUndefined();
    const adminWebhookId = adminCreated.data!.webhookCreate.webhook.id as string;
    expect(
      (
        app.db.query("SELECT owner_id FROM webhooks WHERE id = ?1").get(adminWebhookId) as {
          owner_id: string;
        }
      ).owner_id,
    ).toBeTruthy();

    const ownerListBefore = await gql(app, `{ webhooks { id } }`, {}, ownerKey);
    expect(ownerListBefore.errors).toBeUndefined();
    expect(ownerListBefore.data!.webhooks).toEqual([]);

    const deniedDelete = await gql(
      app,
      `mutation($id: ID!) { webhookDelete(id: $id) { success } }`,
      { id: adminWebhookId },
      ownerKey,
    );
    expect(deniedDelete.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const ownerCreated = await gql(
      app,
      `mutation { webhookCreate(input: { url: "https://example.com/owner" }) { webhook { id } } }`,
      {},
      ownerKey,
    );
    expect(ownerCreated.errors).toBeUndefined();
    const ownerWebhookId = ownerCreated.data!.webhookCreate.webhook.id as string;
    expect(
      (
        app.db.query("SELECT owner_id FROM webhooks WHERE id = ?1").get(ownerWebhookId) as {
          owner_id: string;
        }
      ).owner_id,
    ).toBe(actorId);

    const ownerList = await gql(app, `{ webhooks { id } }`, {}, ownerKey);
    expect(ownerList.data!.webhooks).toEqual([{ id: ownerWebhookId }]);
    const adminList = await gql(app, `{ webhooks { id } }`);
    expect(adminList.data!.webhooks).toEqual(
      expect.arrayContaining([{ id: adminWebhookId }, { id: ownerWebhookId }]),
    );

    const ownerDelete = await gql(
      app,
      `mutation($id: ID!) { webhookDelete(id: $id) { success } }`,
      { id: ownerWebhookId },
      ownerKey,
    );
    expect(ownerDelete.errors).toBeUndefined();

    const adminDelete = await gql(
      app,
      `mutation($id: ID!) { webhookDelete(id: $id) { success } }`,
      { id: adminWebhookId },
    );
    expect(adminDelete.errors).toBeUndefined();
  });

  it("conserva owner y secret en un rebuild local sin exportarlos al repo", async () => {
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "rebuild-webhook-owner", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "rebuild webhook key" }) { key }
      }`,
      { actorId },
    );
    const ownerKey = keyResult.data!.apiKeyCreate.key as string;
    const created = await gql(
      app,
      `mutation { webhookCreate(input: { url: "https://example.com/rebuild" }) { webhook { id } secret } }`,
      {},
      ownerKey,
    );
    const webhookId = created.data!.webhookCreate.webhook.id as string;
    const secret = created.data!.webhookCreate.secret as string;
    const dir = mkdtempSync(join(tmpdir(), "prime-board-webhook-rebuild-"));
    try {
      exportBoard(app.db, dir);
      const result = rebuildFromRepo(app.db, dir);
      expect(result.issues).toBeGreaterThanOrEqual(0);
      const restored = app.db
        .query("SELECT owner_id, secret FROM webhooks WHERE id = ?1")
        .get(webhookId) as {
        owner_id: string;
        secret: string;
      };
      expect(restored).toEqual({ owner_id: actorId, secret });
      const visible = await gql(app, `{ webhooks { id } }`, {}, ownerKey);
      expect(visible.data!.webhooks).toEqual([{ id: webhookId }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
