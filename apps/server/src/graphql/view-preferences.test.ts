// PRB-390: preferencias, defaults y suscripciones persistentes de Views.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("view preferences and subscriptions", () => {
  it("round-trips actor preferences and subscription intent", async () => {
    const created = await gql(
      app,
      `mutation {
        savedViewCreate(input: { name: "Preference view", scope: WORKSPACE, layout: BOARD, columns: ["title"] }) {
          savedView { id preferences { layout scope columns } }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const view = created.data!.savedViewCreate.savedView;
    expect(view.preferences).toMatchObject({ layout: "BOARD", scope: "ACTOR", columns: ["title"] });

    const updated = await gql(
      app,
      `mutation($input: ViewPreferencesUpdateInput!) {
        viewPreferencesUpdate(input: $input) {
          success
          preferences { layout scope orderBy groupBy columns }
        }
      }`,
      {
        input: {
          viewId: view.id,
          scope: "ACTOR",
          layout: "BOARD",
          orderBy: "UPDATED_ASC",
          groupBy: "priority",
          columns: ["assignee"],
        },
      },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.viewPreferencesUpdate.preferences).toMatchObject({
      layout: "BOARD",
      scope: "ACTOR",
      orderBy: "UPDATED_ASC",
      groupBy: "priority",
      columns: ["assignee"],
    });

    const subscribed = await gql(
      app,
      `mutation($id: ID!) {
        viewSubscriptionUpdate(viewId: $id, input: { issueChanges: false, slack: true }) {
          success
          subscription { actor { name } issueChanges slack }
        }
      }`,
      { id: view.id },
    );
    expect(subscribed.errors).toBeUndefined();
    expect(subscribed.data!.viewSubscriptionUpdate.subscription).toMatchObject({
      issueChanges: false,
      slack: true,
      actor: { name: "admin" },
    });

    const fetched = await gql(
      app,
      `query($id: ID!) {
        savedView(id: $id) {
          preferences { layout scope columns }
          displayPreferences { layout }
          subscriptions { actor { name } issueChanges slack }
        }
        viewPreferences(viewId: $id) { layout scope columns }
        savedViewSubscriptions(viewId: $id) { actor { name } issueChanges slack }
      }`,
      { id: view.id },
    );
    expect(fetched.errors).toBeUndefined();
    expect(fetched.data!.savedView.preferences).toMatchObject({
      layout: "BOARD",
      scope: "ACTOR",
      columns: ["assignee"],
    });
    expect(fetched.data!.savedView.displayPreferences.layout).toBe("BOARD");
    expect(fetched.data!.savedView.subscriptions).toEqual([
      { actor: { name: "admin" }, issueChanges: false, slack: true },
    ]);
    expect(fetched.data!.viewPreferences.layout).toBe("BOARD");
    expect(fetched.data!.savedViewSubscriptions).toEqual(fetched.data!.savedView.subscriptions);
  });

  it("requires workspace admin for workspace defaults", async () => {
    const view = await gql(
      app,
      `mutation { savedViewCreate(input: { name: "Workspace default view", scope: WORKSPACE }) { savedView { id } } }`,
    );
    const viewId = view.data!.savedViewCreate.savedView.id;
    const defaultUpdate = await gql(
      app,
      `mutation($id: ID!) {
        viewPreferencesUpdate(input: { viewId: $id, scope: WORKSPACE, layout: BOARD }) { success }
      }`,
      { id: viewId },
    );
    expect(defaultUpdate.errors).toBeUndefined();

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "view-preference-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const key = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "view-preference-key" }) { key } }`,
      { actorId },
    );
    const memberKey = key.data!.apiKeyCreate.key;
    const inherited = await gql(
      app,
      `query($id: ID!) { viewPreferences(viewId: $id) { layout scope } }`,
      { id: viewId },
      memberKey,
    );
    expect(inherited.data!.viewPreferences).toMatchObject({ layout: "BOARD", scope: "WORKSPACE" });

    const result = await gql(
      app,
      `mutation($id: ID!) {
        viewPreferencesUpdate(input: { viewId: $id, scope: WORKSPACE, layout: BOARD }) { success }
      }`,
      { id: viewId },
      memberKey,
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const actorOverride = await gql(
      app,
      `mutation($id: ID!) {
        viewPreferencesUpdate(input: { viewId: $id, scope: ACTOR, layout: LIST }) { success }
      }`,
      { id: viewId },
      memberKey,
    );
    expect(actorOverride.errors).toBeUndefined();
    const overridden = await gql(
      app,
      `query($id: ID!) { viewPreferences(viewId: $id) { layout scope } }`,
      { id: viewId },
      memberKey,
    );
    expect(overridden.data!.viewPreferences).toMatchObject({ layout: "LIST", scope: "ACTOR" });
  });
  it("rechaza targets y suscripciones sin canales", async () => {
    const missingTarget = await gql(
      app,
      `mutation { savedViewCreate(input: { name: "Missing project", scope: PROJECT }) { success } }`,
    );
    expect(missingTarget.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const created = await gql(
      app,
      `mutation { savedViewCreate(input: { name: "Invalid subscription", scope: WORKSPACE }) { savedView { id } } }`,
    );
    const id = created.data!.savedViewCreate.savedView.id;
    const invalid = await gql(
      app,
      `mutation($id: ID!) { viewSubscriptionUpdate(viewId: $id, input: { issueChanges: false, slack: false }) { success } }`,
      { id },
    );
    expect(invalid.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
  it("applies API-key Team limits to project-targeted views", async () => {
    const team = await gql(
      app,
      `mutation { teamCreate(input: { name: "View limit team", key: "VLT" }) { team { id } } }`,
    );
    const teamId = team.data!.teamCreate.team.id;
    const project = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: { name: "View limited project", teamIds: [$teamId] }) { project { id } }
      }`,
      { teamId },
    );
    const projectId = project.data!.projectCreate.project.id;
    const view = await gql(
      app,
      `mutation($projectId: ID!) {
        savedViewCreate(input: { name: "Limited project view", scope: PROJECT, projectId: $projectId }) {
          savedView { id }
        }
      }`,
      { projectId },
    );
    const viewId = view.data!.savedViewCreate.savedView.id;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "view-limit-agent", type: AGENT }) { actor { id } } }`,
    );
    const key = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "view-limit-key", scopes: [READ], teamIds: [$teamId] }) { key }
      }`,
      {
        actorId: actor.data!.actorCreate.actor.id,
        teamId: (await gql(app, `{ team(key: "PB") { id } }`)).data!.team.id,
      },
    );
    const denied = await gql(
      app,
      `query($id: ID!) { savedView(id: $id) { id } viewPreferences(viewId: $id) { layout } }`,
      { id: viewId },
      key.data!.apiKeyCreate.key,
    );
    expect(denied.errors?.every((error) => error.extensions?.code === "UNAUTHORIZED")).toBe(true);
  });
  it("hides initiative-targeted views from actors outside the initiative scope", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const initiative = await gql(
      app,
      `mutation($teamId: ID!) {
        initiativeCreate(input: { name: "Restricted view initiative", teamIds: [$teamId], projectIds: [] }) {
          initiative { id }
        }
      }`,
      { teamId: team.data!.team.id },
    );
    const initiativeId = initiative.data!.initiativeCreate.initiative.id;
    const view = await gql(
      app,
      `mutation($initiativeId: ID!) {
        savedViewCreate(input: { name: "Restricted initiative view", scope: INITIATIVE, initiativeId: $initiativeId }) {
          savedView { id }
        }
      }`,
      { initiativeId },
    );
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "initiative-view-outsider", type: AGENT }) { actor { id } } }`,
    );
    const key = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "initiative-view-key" }) { key } }`,
      { actorId: actor.data!.actorCreate.actor.id },
    );
    const result = await gql(
      app,
      `query($id: ID!) { savedView(id: $id) { id } }`,
      { id: view.data!.savedViewCreate.savedView.id },
      key.data!.apiKeyCreate.key,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.savedView).toBeNull();
  });
});
