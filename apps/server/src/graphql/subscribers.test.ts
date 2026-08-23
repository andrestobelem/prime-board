// PRB-529: suscripciones de issues, autorización, idempotencia y entrega al inbox.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";

const app = createTestApp();
afterAll(() => app.stop());

async function createActorKey(name: string): Promise<{ id: string; key: string }> {
  const actor = await gql(
    app,
    `mutation($name: String!) { actorCreate(input: { name: $name, type: AGENT }) { actor { id } } }`,
    { name },
  );
  const id = actor.data!.actorCreate.actor.id as string;
  const created = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "test" }) { key } }`,
    { actorId: id },
  );
  return { id, key: created.data!.apiKeyCreate.key as string };
}

describe("issue subscribers", () => {
  it("suscribe, lista, filtra y cancela de forma idempotente", async () => {
    const actor = await createActorKey("subscriber-agent");
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Subscription target" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id as string;

    const first = await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { issue { subscribers { id } } } }`,
      { id: issueId },
      actor.key,
    );
    expect(first.errors).toBeUndefined();
    expect(first.data!.issueSubscribe.issue.subscribers).toEqual([{ id: actor.id }]);

    const second = await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { success issue { subscribers { id } } } }`,
      { id: issueId },
      actor.key,
    );
    expect(second.errors).toBeUndefined();
    expect(second.data!.issueSubscribe.issue.subscribers).toHaveLength(1);

    const filtered = await gql(
      app,
      `query { issues(filter: { subscribed: true }) { nodes { id } } }`,
      {},
      actor.key,
    );
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data!.issues.nodes).toContainEqual({ id: issueId });

    const firstUnsubscribe = await gql(
      app,
      `mutation($id: ID!) { issueUnsubscribe(id: $id) { issue { subscribers { id } } } }`,
      { id: issueId },
      actor.key,
    );
    expect(firstUnsubscribe.errors).toBeUndefined();
    expect(firstUnsubscribe.data!.issueUnsubscribe.issue.subscribers).toEqual([]);

    const secondUnsubscribe = await gql(
      app,
      `mutation($id: ID!) { issueUnsubscribe(id: $id) { success issue { id } } }`,
      { id: issueId },
      actor.key,
    );
    expect(secondUnsubscribe.errors).toBeUndefined();
  });

  it("entrega cambios posteriores al subscriber en el inbox", async () => {
    const actor = await createActorKey("subscriber-inbox-agent");
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Inbox subscription target" }) { issue { id identifier } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    const identifier = issue.data!.issueCreate.issue.identifier as string;
    await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { success } }`,
      { id: issueId },
      actor.key,
    );

    const priority = await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { priority: 1 }) { success } }`,
      { id: issueId },
    );
    expect(priority.errors).toBeUndefined();
    const inbox = await gql(app, `{ inbox { type issue { id } actor { id } } }`, {}, actor.key);
    expect(inbox.errors).toBeUndefined();
    expect(
      (
        inbox.data!.inbox as Array<{ type: string; issue: { id: string }; actor: { id: string } }>
      ).some((entry) => entry.type === "priority_changed" && entry.issue.id === issueId),
    ).toBe(true);
  });

  it("preserva suscriptores en export y rebuild", async () => {
    const actor = await createActorKey("subscriber-roundtrip-agent");
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Subscription roundtrip" }) { issue { id identifier } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    const identifier = issue.data!.issueCreate.issue.identifier as string;
    await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { success } }`,
      { id: issueId },
      actor.key,
    );

    const rootDir = mkdtempSync(join(tmpdir(), "pb-subscriber-roundtrip-"));
    try {
      exportBoard(app.db, rootDir);
      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, rootDir);
      expect(
        fresh
          .query(
            "SELECT actor_id FROM issue_subscribers JOIN issues ON issues.id = issue_subscribers.issue_id JOIN teams ON teams.id = issues.team_id WHERE teams.key || '-' || issues.number = ?1 AND issue_subscribers.workspace_id IS NOT NULL",
          )
          .get(identifier),
      ).toEqual({ actor_id: actor.id });
      fresh.close();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rechaza issues privados y archivados sin crear relaciones", async () => {
    const actor = await createActorKey("subscriber-permissions-agent");
    const privateTeam = await gql(
      app,
      `mutation { teamCreate(input: { name: "Private Subscriptions", key: "SUB", visibility: PRIVATE, accessPolicy: TEAM_MEMBERS }) { team { id } } }`,
    );
    const privateIssue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "SUB", title: "Private target" }) { issue { id } } }`,
    );
    const privateResult = await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { success } }`,
      { id: privateIssue.data!.issueCreate.issue.id },
      actor.key,
    );
    expect(privateResult.data).toBeNull();
    expect(privateResult.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(privateTeam.data!.teamCreate.team.id).toBeTruthy();

    const archived = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Archived target" }) { issue { id } } }`,
    );
    const archivedId = archived.data!.issueCreate.issue.id as string;
    await gql(app, `mutation($id: ID!) { issueArchive(id: $id) { success } }`, { id: archivedId });
    const archivedResult = await gql(
      app,
      `mutation($id: ID!) { issueSubscribe(id: $id) { success } }`,
      { id: archivedId },
      actor.key,
    );
    expect(archivedResult.data).toBeNull();
    expect(archivedResult.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
