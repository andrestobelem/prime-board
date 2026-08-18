// PRB-201: vistas guardadas — CRUD GraphQL y apertura por id.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("saved views", () => {
  it("crea una vista de team con filtro y orden, y la lista", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;

    const created = await gql(
      app,
      `
      mutation($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) {
          success
          savedView {
            id
            name
            scope
            team { id }
            filter
            orderBy
            groupBy
            owner { name }
          }
        }
      }
    `,
      {
        input: {
          name: "Unblocked bugs",
          scope: "TEAM",
          teamId,
          filter: { team: { eq: teamId }, unblocked: true },
          orderBy: "UPDATED_DESC",
          groupBy: "priority",
        },
      },
    );

    expect(created.errors).toBeUndefined();
    const view = created.data!.savedViewCreate.savedView;
    expect(view).toMatchObject({
      name: "Unblocked bugs",
      scope: "TEAM",
      orderBy: "UPDATED_DESC",
      groupBy: "priority",
      owner: { name: "admin" },
      filter: { team: { eq: teamId }, unblocked: true },
    });
    expect(view.team.id).toBe(teamId);

    const listed = await gql(
      app,
      `
      query($teamId: ID!) {
        savedViews(teamId: $teamId) {
          id
          name
          scope
        }
      }
    `,
      { teamId },
    );
    expect(listed.errors).toBeUndefined();
    expect(listed.data!.savedViews).toEqual([
      { id: view.id, name: "Unblocked bugs", scope: "TEAM" },
    ]);

    const fetched = await gql(
      app,
      `
      query($id: ID!) {
        savedView(id: $id) {
          id
          name
          filter
          orderBy
          groupBy
        }
      }
    `,
      { id: view.id },
    );
    expect(fetched.data!.savedView).toMatchObject({
      id: view.id,
      name: "Unblocked bugs",
      orderBy: "UPDATED_DESC",
      groupBy: "priority",
    });
  });

  it("actualiza y borra una vista; rechaza nombre vacío", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;
    const created = await gql(
      app,
      `
      mutation($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) { savedView { id } }
      }
    `,
      {
        input: {
          name: "Temp view",
          scope: "WORKSPACE",
          filter: { search: "webhook" },
        },
      },
    );
    const id = created.data!.savedViewCreate.savedView.id;

    const updated = await gql(
      app,
      `
      mutation($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) {
          savedView { id name filter groupBy }
        }
      }
    `,
      { id, input: { name: "Webhooks", groupBy: "state" } },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.savedViewUpdate.savedView).toMatchObject({
      id,
      name: "Webhooks",
      groupBy: "state",
      filter: { search: "webhook" },
    });

    const empty = await gql(
      app,
      `
      mutation($id: ID!) {
        savedViewUpdate(id: $id, input: { name: "  " }) { success }
      }
    `,
      { id },
    );
    expect(empty.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const deleted = await gql(app, `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`, {
      id,
    });
    expect(deleted.data!.savedViewDelete.success).toBe(true);

    const missing = await gql(app, `query($id: ID!) { savedView(id: $id) { id } }`, { id });
    expect(missing.data!.savedView).toBeNull();

    // teamId unused but kept for clarity of scope in this suite
    expect(teamId).toBeTruthy();
  });

  it("aplica membership a vistas de team en consultas y mutaciones", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;
    const created = await gql(
      app,
      `mutation($teamId: ID!) {
        savedViewCreate(input: { name: "Private team view", scope: TEAM, teamId: $teamId }) {
          savedView { id }
        }
      }`,
      { teamId },
    );
    const viewId = created.data!.savedViewCreate.savedView.id;

    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "view-member", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id;
    const memberKeyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "member-view" }) { key } }`,
      { actorId: memberId },
    );
    const memberKey = memberKeyResult.data!.apiKeyCreate.key;
    await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
      }`,
      { teamId, actorId: memberId },
    );

    const memberList = await gql(
      app,
      `query($teamId: ID!) { savedViews(teamId: $teamId) { id name scope } }`,
      { teamId },
      memberKey,
    );
    expect(memberList.errors).toBeUndefined();
    expect(memberList.data!.savedViews).toContainEqual({
      id: viewId,
      name: "Private team view",
      scope: "TEAM",
    });
    const memberUpdate = await gql(
      app,
      `mutation($id: ID!) { savedViewUpdate(id: $id, input: { name: "Member renamed" }) { savedView { name } } }`,
      { id: viewId },
      memberKey,
    );
    expect(memberUpdate.errors).toBeUndefined();

    const outsider = await gql(
      app,
      `mutation { actorCreate(input: { name: "view-outsider", type: AGENT }) { actor { id } } }`,
    );
    const outsiderId = outsider.data!.actorCreate.actor.id;
    const outsiderKeyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "outsider-view" }) { key } }`,
      { actorId: outsiderId },
    );
    const outsiderKey = outsiderKeyResult.data!.apiKeyCreate.key;

    const outsiderList = await gql(
      app,
      `query($teamId: ID!) { savedViews(teamId: $teamId) { id } }`,
      { teamId },
      outsiderKey,
    );
    expect(outsiderList.errors).toBeUndefined();
    expect(outsiderList.data!.savedViews).toEqual([]);
    const outsiderGet = await gql(
      app,
      `query($id: ID!) { savedView(id: $id) { id } }`,
      { id: viewId },
      outsiderKey,
    );
    expect(outsiderGet.errors).toBeUndefined();
    expect(outsiderGet.data!.savedView).toBeNull();

    for (const mutation of [
      `mutation($id: ID!) { savedViewUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
      `mutation($id: ID!) { savedViewDuplicate(id: $id) { success } }`,
      `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`,
    ]) {
      const denied = await gql(app, mutation, { id: viewId }, outsiderKey);
      expect(denied.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }

    const outsiderCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        savedViewCreate(input: { name: "orphan", scope: TEAM, teamId: $teamId }) { success }
      }`,
      { teamId },
      outsiderKey,
    );
    expect(outsiderCreate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("vistas personales solo las ve su dueño", async () => {
    const mine = await gql(
      app,
      `
      mutation {
        savedViewCreate(input: { name: "Mine", scope: PERSONAL, filter: {} }) {
          savedView { id scope }
        }
      }
    `,
    );
    expect(mine.data!.savedViewCreate.savedView.scope).toBe("PERSONAL");

    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "view-agent", type: AGENT }) { actor { id } } }`,
    );
    const key = await gql(
      app,
      `
      mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "k" }) { key }
      }
    `,
      { actorId: agent.data!.actorCreate.actor.id },
    );

    const asAgent = await gql(
      app,
      `{ savedViews { id name scope } }`,
      {},
      key.data!.apiKeyCreate.key,
    );
    expect(asAgent.errors).toBeUndefined();
    expect(asAgent.data!.savedViews.some((v: { name: string }) => v.name === "Mine")).toBe(false);
    expect(asAgent.data!.savedViews.every((v: { scope: string }) => v.scope !== "PERSONAL")).toBe(
      true,
    );
  });
});
