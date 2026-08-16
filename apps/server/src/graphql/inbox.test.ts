// PRB-202: Inbox y My issues — eventos relevantes al viewer autenticado.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("inbox y my issues", () => {
  it("inbox lista asignaciones y comentarios en issues del viewer", async () => {
    const setup = await gql(app, `{ viewer { id } team(key: "PB") { id states { id type } } }`);
    const viewerId = setup.data!.viewer.id;
    const todoId = setup.data!.team.states.find((s: { type: string }) => s.type === "UNSTARTED").id;

    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "inbox-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const agentKey = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "inbox" }) { key }
      }`,
      { actorId: agentId },
    );
    const key = agentKey.data!.apiKeyCreate.key;

    // Issue asignado al agente por admin → debe aparecer en inbox del agente.
    const assigned = await gql(
      app,
      `mutation($assigneeId: ID!, $stateId: ID!) {
        issueCreate(input: {
          teamKey: "PB", title: "For agent", assigneeId: $assigneeId, stateId: $stateId
        }) { issue { id identifier } }
      }`,
      { assigneeId: agentId, stateId: todoId },
    );
    const issueId = assigned.data!.issueCreate.issue.id;
    const identifier = assigned.data!.issueCreate.issue.identifier;

    // Comentario de admin en ese issue → también en inbox.
    await gql(
      app,
      `mutation($issueId: ID!) {
        commentCreate(input: { issueId: $issueId, body: "please look" }) {
          comment { id }
        }
      }`,
      { issueId },
    );

    // Issue de otro (admin) con comentario propio del agente: no debe saturar su inbox.
    const other = await gql(
      app,
      `mutation($stateId: ID!) {
        issueCreate(input: {
          teamKey: "PB", title: "Admin only", assigneeId: "${viewerId}", stateId: $stateId
        }) { issue { id } }
      }`,
      { stateId: todoId },
    );
    await gql(
      app,
      `mutation($issueId: ID!) {
        commentCreate(input: { issueId: $issueId, body: "my note" }) { comment { id } }
      }`,
      { issueId: other.data!.issueCreate.issue.id },
      key,
    );

    const inbox = await gql(
      app,
      `{ inbox(first: 20) {
        id type createdAt
        actor { id name }
        issue { identifier title }
        payload
      } }`,
      {},
      key,
    );

    expect(inbox.errors).toBeUndefined();
    const items = inbox.data!.inbox as Array<{
      type: string;
      issue: { identifier: string };
      actor: { id: string };
      payload: Record<string, unknown>;
    }>;
    // Asignación al crear (activity "created" con assigneeId) o "assigned" explícito.
    expect(
      items.some(
        (item) =>
          item.issue.identifier === identifier &&
          (item.type === "assigned" ||
            (item.type === "created" && item.payload.assigneeId === agentId)),
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) =>
          item.type === "commented" &&
          item.issue.identifier === identifier &&
          item.actor.id === viewerId,
      ),
    ).toBe(true);
    // No incluye la actividad del propio agente.
    expect(items.every((item) => item.actor.id !== agentId)).toBe(true);
  });

  it("issues filtrados por assignee del viewer cubren My issues", async () => {
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "my-issues-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const agentKey = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "my" }) { key }
      }`,
      { actorId: agentId },
    );
    const key = agentKey.data!.apiKeyCreate.key;

    await gql(
      app,
      `mutation($assigneeId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Mine A", assigneeId: $assigneeId }) {
          issue { identifier }
        }
      }`,
      { assigneeId: agentId },
    );
    await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Not mine" }) { issue { id } } }`,
    );

    const mine = await gql(
      app,
      `query($assigneeId: ID!) {
        issues(filter: { assignee: { eq: $assigneeId } }, first: 50) {
          nodes { title assignee { id } }
        }
      }`,
      { assigneeId: agentId },
      key,
    );

    expect(mine.errors).toBeUndefined();
    const nodes = mine.data!.issues.nodes as Array<{ title: string; assignee: { id: string } }>;
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.every((n) => n.assignee.id === agentId)).toBe(true);
    expect(nodes.some((n) => n.title === "Mine A")).toBe(true);
    expect(nodes.some((n) => n.title === "Not mine")).toBe(false);
  });
});
