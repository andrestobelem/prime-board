// Regresiones de visibilidad y política de acceso de Teams (PRB-381).
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("visibilidad y política de Teams", () => {
  it("oculta Teams privados y separa lectura pública de escritura", async () => {
    const created = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Security"
          key: "sec"
          visibility: PRIVATE
          accessPolicy: TEAM_MEMBERS
        }) { team { id key visibility accessPolicy } }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const teamId = created.data!.teamCreate.team.id;

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "external-agent", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const key = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "external key" }) { key }
      }`,
      { actorId },
    );
    const externalKey = key.data!.apiKeyCreate.key;

    const hidden = await gql(app, `{ team(key: "SEC") { id } }`, {}, externalKey);
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data!.team).toBeNull();

    const hiddenWrite = await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "should be hidden" }) { issue { id } }
      }`,
      { teamId },
      externalKey,
    );
    expect(hiddenWrite.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const scopedWebhook = await gql(
      app,
      `mutation($teamId: ID!) {
        webhookCreate(input: { url: "https://example.test/private", teamId: $teamId }) {
          webhook { id teamId }
        }
      }`,
      { teamId },
    );
    expect(scopedWebhook.errors).toBeUndefined();
    const hiddenWebhookDelete = await gql(
      app,
      `mutation($id: ID!) { webhookDelete(id: $id) { success } }`,
      { id: scopedWebhook.data!.webhookCreate.webhook.id },
      externalKey,
    );
    expect(hiddenWebhookDelete.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const hiddenWebhookCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        webhookCreate(input: { url: "https://example.test/private-outsider", teamId: $teamId }) {
          webhook { id }
        }
      }`,
      { teamId },
      externalKey,
    );
    expect(hiddenWebhookCreate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    await gql(
      app,
      `mutation($teamId: ID!) {
        teamUpdate(id: $teamId, input: { visibility: PUBLIC, accessPolicy: TEAM_MEMBERS }) {
          team { visibility accessPolicy }
        }
      }`,
      { teamId },
    );
    const label = await gql(
      app,
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "Security label", teamId: $teamId }) { label { id } }
      }`,
      { teamId },
    );
    expect(label.errors).toBeUndefined();
    const publicRead = await gql(
      app,
      `query($teamId: ID!) {
        team(key: "SEC") {
          visibility
          accessPolicy
          states { id }
          labels { id }
        }
        labels(team: $teamId) { id }
      }`,
      { teamId },
      externalKey,
    );
    expect(publicRead.data!.team).toMatchObject({
      visibility: "PUBLIC",
      accessPolicy: "TEAM_MEMBERS",
    });
    expect(publicRead.data!.team.labels).toHaveLength(1);
    expect(publicRead.data!.labels).toHaveLength(1);

    const deniedWrite = await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "still read-only" }) { issue { id } }
      }`,
      { teamId },
      externalKey,
    );
    expect(deniedWrite.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const deniedWebhookCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        webhookCreate(input: { url: "https://example.test/team-member-only", teamId: $teamId }) {
          webhook { id }
        }
      }`,
      { teamId },
      externalKey,
    );
    expect(deniedWebhookCreate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const enabled = await gql(
      app,
      `mutation($teamId: ID!) {
        teamUpdate(id: $teamId, input: { accessPolicy: WORKSPACE_MEMBERS }) {
          team { accessPolicy }
        }
      }`,
      { teamId },
    );
    expect(enabled.errors).toBeUndefined();
    const allowedWrite = await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "workspace write" }) { issue { id } }
      }`,
      { teamId },
      externalKey,
    );
    expect(allowedWrite.errors).toBeUndefined();
    const allowedWebhookCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        webhookCreate(input: { url: "https://example.test/workspace-members", teamId: $teamId }) {
          webhook { id }
        }
      }`,
      { teamId },
      externalKey,
    );
    expect(allowedWebhookCreate.errors).toBeUndefined();
  });

  it("no permite usar actores suspendidos como assignees", async () => {
    const team = await gql(
      app,
      `mutation { teamCreate(input: { name: "Assignments", key: "asg" }) { team { id } } }`,
    );
    const teamId = team.data!.teamCreate.team.id;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "temporary-assignee", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const issue = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "assignment" assigneeId: $actorId }) { issue { id } }
      }`,
      { teamId, actorId },
    );
    expect(issue.errors).toBeUndefined();
    const suspended = await gql(app, `mutation($id: ID!) { actorSuspend(id: $id) { success } }`, {
      id: actorId,
    });
    expect(suspended.errors).toBeUndefined();
    const update = await gql(
      app,
      `mutation($id: ID!, $actorId: ID!) {
        issueUpdate(id: $id, input: { assigneeId: $actorId }) { issue { id } }
      }`,
      { id: issue.data!.issueCreate.issue.id, actorId },
    );
    expect(update.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});
