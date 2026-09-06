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

describe("actor profile", () => {
  it("exposes and updates avatarUrl, including clearing it", async () => {
    const created = await gql(
      app,
      `mutation {
        actorCreate(input: { name: "profile-agent", type: AGENT, avatarUrl: " https://example.com/profile.png " }) {
          actor { id name avatarUrl }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const actor = created.data!.actorCreate.actor;
    expect(actor).toMatchObject({
      name: "profile-agent",
      avatarUrl: "https://example.com/profile.png",
    });

    const cleared = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { avatarUrl: null }) { actor { id avatarUrl } } }`,
      { id: actor.id },
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data!.actorUpdate.actor).toEqual({ id: actor.id, avatarUrl: null });

    const tooLong = await gql(
      app,
      `mutation($id: ID!, $avatarUrl: String) {
        actorUpdate(id: $id, input: { avatarUrl: $avatarUrl }) { success }
      }`,
      { id: actor.id, avatarUrl: `https://example.com/${"a".repeat(2049)}` },
    );
    expect(tooLong.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const unsafe = await gql(
      app,
      `mutation($id: ID!, $avatarUrl: String) {
        actorUpdate(id: $id, input: { avatarUrl: $avatarUrl }) { success }
      }`,
      { id: actor.id, avatarUrl: "javascript:alert(1)" },
    );
    expect(unsafe.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("keeps profile updates within the existing self/admin policy", async () => {
    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "profile-member", type: AGENT }) { actor { id } } }`,
    );
    const other = await gql(
      app,
      `mutation { actorCreate(input: { name: "profile-other", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id;
    const otherId = other.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "profile login" }) { key } }`,
      { actorId: memberId },
    );
    const memberKey = keyResult.data!.apiKeyCreate.key;

    const ownUpdate = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { avatarUrl: "https://example.com/member.png" }) { actor { avatarUrl } } }`,
      { id: memberId },
      memberKey,
    );
    expect(ownUpdate.errors).toBeUndefined();
    expect(ownUpdate.data!.actorUpdate.actor.avatarUrl).toBe("https://example.com/member.png");

    const foreignUpdate = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { avatarUrl: "https://example.com/other.png" }) { success } }`,
      { id: otherId },
      memberKey,
    );
    expect(foreignUpdate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("preserves profile avatars through actors.json export and rebuild", async () => {
    const updated = await gql(
      app,
      `mutation { actorUpdate(id: "${(await gql(app, "{ viewer { id } }")).data!.viewer.id}", input: { avatarUrl: "https://example.com/admin.png" }) { actor { id avatarUrl } } }`,
    );
    expect(updated.errors).toBeUndefined();

    const snapshot = mkdtempSync(join(tmpdir(), "pb-profile-export-"));
    const rebuilt = openDatabase(":memory:");
    try {
      exportBoard(app.db, snapshot);
      const actors = JSON.parse(
        readFileSync(join(snapshot, ".prime-board", "meta", "actors.json"), "utf8"),
      ) as Array<{ name: string; avatarUrl: string | null }>;
      expect(actors.find((actor) => actor.name === "admin")?.avatarUrl).toBe(
        "https://example.com/admin.png",
      );

      rebuildFromRepo(rebuilt, snapshot);
      expect(
        (
          rebuilt.query("SELECT avatar_url FROM actors WHERE name = 'admin'").get() as {
            avatar_url: string | null;
          }
        ).avatar_url,
      ).toBe("https://example.com/admin.png");
    } finally {
      rebuilt.close();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });
});
