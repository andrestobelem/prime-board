// Regresión de aislamiento para las colecciones de Workspace.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("aislamiento de colecciones por Workspace", () => {
  it("crea y lista recursos solo en el Workspace seleccionado", async () => {
    const createdWorkspace = await gql(
      app,
      `mutation {
        workspaceCreate(input: { name: "Collections", urlKey: "collections-other" }) {
          workspace { id urlKey }
        }
      }`,
    );
    expect(createdWorkspace.errors).toBeUndefined();

    const bootstrap = await gql(
      app,
      `{ teams { id key } actors { id name workspaceRole } }`,
      {},
      app.apiKey,
      "collections-other",
    );
    expect(bootstrap.errors).toBeUndefined();
    const teamId = bootstrap.data!.teams[0].id as string;

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "only-in-collections", type: AGENT }) { actor { id } } }`,
      {},
      app.apiKey,
      "collections-other",
    );
    expect(actor.errors).toBeUndefined();
    const actorId = actor.data!.actorCreate.actor.id as string;

    const project = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "Collections project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId },
      app.apiKey,
      "collections-other",
    );
    expect(project.errors).toBeUndefined();
    const projectId = project.data!.projectCreate.project.id as string;

    const label = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "collections-label", teamId: $teamId }) { label { id } } }`,
      { teamId },
      app.apiKey,
      "collections-other",
    );
    expect(label.errors).toBeUndefined();
    const labelId = label.data!.labelCreate.label.id as string;

    const savedView = await gql(
      app,
      `mutation($teamId: ID!) { savedViewCreate(input: { name: "Collections view", scope: TEAM, teamId: $teamId }) { savedView { id } } }`,
      { teamId },
      app.apiKey,
      "collections-other",
    );
    expect(savedView.errors).toBeUndefined();
    const savedViewId = savedView.data!.savedViewCreate.savedView.id as string;

    const initiative = await gql(
      app,
      `mutation($teamId: ID!) { initiativeCreate(input: { name: "Collections initiative", teamIds: [$teamId] }) { initiative { id } } }`,
      { teamId },
      app.apiKey,
      "collections-other",
    );
    expect(initiative.errors).toBeUndefined();
    const initiativeId = initiative.data!.initiativeCreate.initiative.id as string;

    const webhook = await gql(
      app,
      `mutation($teamId: ID!) { webhookCreate(input: { url: "https://collections.example/hook", teamId: $teamId }) { webhook { id } } }`,
      { teamId },
      app.apiKey,
      "collections-other",
    );
    expect(webhook.errors).toBeUndefined();
    const webhookId = webhook.data!.webhookCreate.webhook.id as string;

    const selected = await gql(
      app,
      `{ teams { id } projects { id } labels { id } savedViews { id } initiatives { id } webhooks { id } actors { id } }`,
      {},
      app.apiKey,
      "collections-other",
    );
    expect(selected.errors).toBeUndefined();
    expect(selected.data!.teams.map((row: { id: string }) => row.id)).toEqual([teamId]);
    expect(selected.data!.projects.map((row: { id: string }) => row.id)).toContain(projectId);
    expect(selected.data!.labels.map((row: { id: string }) => row.id)).toContain(labelId);
    expect(selected.data!.savedViews.map((row: { id: string }) => row.id)).toContain(savedViewId);
    expect(selected.data!.initiatives.map((row: { id: string }) => row.id)).toContain(initiativeId);
    expect(selected.data!.webhooks.map((row: { id: string }) => row.id)).toContain(webhookId);
    expect(selected.data!.actors.map((row: { id: string }) => row.id)).toContain(actorId);

    const legacy = await gql(
      app,
      `{ projects { id } labels { id } savedViews { id } initiatives { id } webhooks { id } actors { id } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    expect(legacy.errors).toBeUndefined();
    for (const collection of [
      "projects",
      "labels",
      "savedViews",
      "initiatives",
      "webhooks",
      "actors",
    ]) {
      expect(legacy.data![collection].map((row: { id: string }) => row.id)).not.toContain(
        collection === "projects"
          ? projectId
          : collection === "labels"
            ? labelId
            : collection === "savedViews"
              ? savedViewId
              : collection === "initiatives"
                ? initiativeId
                : collection === "webhooks"
                  ? webhookId
                  : actorId,
      );
    }
  });
});
