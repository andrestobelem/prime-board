// Autorización de issues: sólo actores con membership pueden mutar el team.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

async function createActor(name: string): Promise<{ id: string; key: string }> {
  const actor = await gql(
    app,
    `mutation($name: String!) {
      actorCreate(input: { name: $name, type: HUMAN }) { actor { id } }
    }`,
    { name },
  );
  const actorId = actor.data!.actorCreate.actor.id as string;
  const apiKey = await gql(
    app,
    `mutation($actorId: ID!, $name: String!) {
      apiKeyCreate(input: { actorId: $actorId, name: $name }) { key }
    }`,
    { actorId, name: `${name}-key` },
  );
  return { id: actorId, key: apiKey.data!.apiKeyCreate.key as string };
}

describe("issue authorization", () => {
  it("denies issue mutations to outsiders and stale keys after membership revocation", async () => {
    const team = (await gql(app, `{ teams { id key } }`)).data!.teams[0];
    const outsider = await createActor("issue-outsider");
    const member = await createActor("issue-member");
    const membership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) {
          membership { id }
        }
      }`,
      { teamId: team.id, actorId: member.id },
    );
    const issue = await gql(
      app,
      `mutation($teamKey: String!, $title: String!) {
        issueCreate(input: { teamKey: $teamKey, title: $title }) { issue { id identifier } }
      }`,
      { teamKey: team.key, title: "protected issue" },
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    const secondIssue = await gql(
      app,
      `mutation($teamKey: String!, $title: String!) {
        issueCreate(input: { teamKey: $teamKey, title: $title }) { issue { id } }
      }`,
      { teamKey: team.key, title: "second protected issue" },
    );
    const secondIssueId = secondIssue.data!.issueCreate.issue.id as string;

    const createDenied = await gql(
      app,
      `mutation($teamKey: String!) {
        issueCreate(input: { teamKey: $teamKey, title: "outsider issue" }) { success }
      }`,
      { teamKey: team.key },
      outsider.key,
    );
    expect(createDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    for (const mutation of [
      `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "changed" }) { success } }`,
      `mutation($id: ID!) { issueArchive(id: $id) { success } }`,
      `mutation($id: ID!) { commentCreate(input: { issueId: $id, body: "outsider" }) { success } }`,
      `mutation($id: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $id, relatedIssueId: $related, type: RELATED }) { success }
      }`,
    ]) {
      const result = await gql(
        app,
        mutation,
        { id: issueId, related: secondIssueId },
        outsider.key,
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    }

    const memberUpdate = await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "member changed" }) { success } }`,
      { id: issueId },
      member.key,
    );
    expect(memberUpdate.errors).toBeUndefined();

    const relation = await gql(
      app,
      `mutation($id: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $id, relatedIssueId: $related, type: RELATED }) {
          relation { id }
        }
      }`,
      { id: issueId, related: secondIssueId },
      member.key,
    );
    expect(relation.errors).toBeUndefined();
    const relationDenied = await gql(
      app,
      `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
      { id: relation.data!.issueRelationCreate.relation.id },
      outsider.key,
    );
    expect(relationDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const revoke = await gql(
      app,
      `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
      { id: membership.data!.teamMembershipCreate.membership.id },
    );
    expect(revoke.errors).toBeUndefined();

    const staleUpdate = await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "stale changed" }) { success } }`,
      { id: issueId },
      member.key,
    );
    expect(staleUpdate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});
