import { afterEach, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp | null = null;
afterEach(() => app?.stop());

const PREFERENCE_FIELDS = `
  actorId workspaceId category channel enabled emailDelivery createdAt updatedAt
`;

describe("notification preferences", () => {
  it("returns the complete default matrix for the authenticated Actor", async () => {
    app = createTestApp();
    const result = await gql(app, `{ notificationPreferences { ${PREFERENCE_FIELDS} } }`);

    expect(result.errors).toBeUndefined();
    const preferences = result.data!.notificationPreferences as Array<{
      category: string;
      channel: string;
      enabled: boolean;
      emailDelivery: string | null;
    }>;
    expect(preferences).toHaveLength(30);
    expect(preferences.every((preference) => preference.enabled)).toBe(true);
    expect(
      preferences
        .filter((preference) => preference.channel === "EMAIL")
        .every((preference) => preference.emailDelivery === "DIGEST"),
    ).toBe(true);
    expect(
      preferences
        .filter((preference) => preference.channel !== "EMAIL")
        .every((preference) => preference.emailDelivery === null),
    ).toBe(true);
  });

  it("updates categories and keeps Email delivery independent from enabled", async () => {
    app = createTestApp();
    const updated = await gql(
      app,
      `mutation($input: NotificationPreferencesUpdateInput!) {
        notificationPreferencesUpdate(input: $input) {
          success
          preferences { category channel enabled emailDelivery }
        }
      }`,
      {
        input: {
          preferences: [
            { category: "MENTIONS", channel: "DESKTOP", enabled: false },
            {
              category: "STATUS_CHANGES",
              channel: "EMAIL",
              enabled: true,
              emailDelivery: "IMMEDIATE",
            },
          ],
        },
      },
    );

    expect(updated.errors).toBeUndefined();
    const preferences = updated.data!.notificationPreferencesUpdate.preferences as Array<{
      category: string;
      channel: string;
      enabled: boolean;
      emailDelivery: string | null;
    }>;
    expect(
      preferences.find(
        (preference) => preference.category === "MENTIONS" && preference.channel === "DESKTOP",
      ),
    ).toMatchObject({ enabled: false, emailDelivery: null });
    expect(
      preferences.find(
        (preference) => preference.category === "STATUS_CHANGES" && preference.channel === "EMAIL",
      ),
    ).toMatchObject({ enabled: true, emailDelivery: "IMMEDIATE" });

    const read = await gql(
      app,
      `{ notificationPreferences { category channel enabled emailDelivery } }`,
    );
    expect(read.errors).toBeUndefined();
    expect(
      read.data!.notificationPreferences.find(
        (preference: { category: string; channel: string }) =>
          preference.category === "MENTIONS" && preference.channel === "DESKTOP",
      ),
    ).toMatchObject({ enabled: false });
  });

  it("rejects duplicate pairs and email delivery on another channel", async () => {
    app = createTestApp();
    const duplicate = await gql(
      app,
      `mutation {
        notificationPreferencesUpdate(input: { preferences: [
          { category: ASSIGNMENTS, channel: INBOX, enabled: false },
          { category: ASSIGNMENTS, channel: INBOX, enabled: true }
        ] }) { success }
      }`,
    );
    expect(duplicate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(
      (
        app.db.query("SELECT count(*) AS count FROM notification_preferences").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);

    const invalidDelivery = await gql(
      app,
      `mutation {
        notificationPreferencesUpdate(input: { preferences: [
          { category: ASSIGNMENTS, channel: DESKTOP, enabled: true, emailDelivery: DIGEST }
        ] }) { success }
      }`,
    );
    expect(invalidDelivery.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(
      (
        app.db.query("SELECT count(*) AS count FROM notification_preferences").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("keeps preferences private to the API-key Actor", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "notification-reader", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const teamId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string })
      .id;
    const created = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: {
          actorId: $actorId, name: "notification-reader", scopes: [READ, WRITE], teamIds: [$teamId]
        }) { key }
      }`,
      { actorId, teamId },
    );
    const key = created.data!.apiKeyCreate.key;

    const own = await gql(app, `{ notificationPreferences { actorId } }`, {}, key);
    expect(own.errors).toBeUndefined();
    expect(
      own.data!.notificationPreferences.every(
        (row: { actorId: string }) => row.actorId === actorId,
      ),
    ).toBe(true);

    const changed = await gql(
      app,
      `mutation {
        notificationPreferencesUpdate(input: { preferences: [
          { category: MENTIONS, channel: INBOX, enabled: false }
        ] }) { success }
      }`,
      {},
      key,
    );
    expect(changed.errors).toBeUndefined();
    expect(
      (
        app.db
          .query(
            "SELECT enabled FROM notification_preferences WHERE actor_id = ?1 AND category = 'mentions' AND channel = 'inbox'",
          )
          .get(actorId) as { enabled: number }
      ).enabled,
    ).toBe(0);
    expect(
      (
        app.db
          .query(
            "SELECT count(*) AS count FROM notification_preferences WHERE actor_id = (SELECT id FROM actors WHERE name = 'admin')",
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});
