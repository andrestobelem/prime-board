// PRB-391: contrato de Settings de Projects e Initiatives.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("planning settings", () => {
  it("persiste members, fechas, dependencias y propiedades de Initiative", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id as string;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "project-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const first = await gql(
      app,
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id startDate members { id } } } }`,
      {
        input: {
          name: "Dependency source",
          teamIds: [teamId],
          memberIds: [actorId],
          startDate: "2026-09-01",
          targetDate: "2026-09-30",
        },
      },
    );
    expect(first.errors).toBeUndefined();
    const source = first.data!.projectCreate.project;
    const target = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "Dependency target", teamIds: [$teamId] }) { project { id } } }`,
      { teamId },
    );
    const targetId = target.data!.projectCreate.project.id as string;
    const updated = await gql(
      app,
      `mutation($id: ID!, $dependency: ID!) { projectUpdate(id: $id, input: { dependencyIds: [$dependency] }) { project { dependencies { dependsOnProject { id } type } } } }`,
      { id: source.id, dependency: targetId },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.projectUpdate.project.dependencies).toEqual([
      { dependsOnProject: { id: targetId }, type: "BLOCKS" },
    ]);

    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "strategic", color: "#fff" }) { label { id } } }`,
    );
    const initiative = await gql(
      app,
      `mutation($labelId: ID!, $teamId: ID!, $projectId: ID!) { initiativeCreate(input: { name: "Roadmap", priority: 2, leadTeamId: $teamId, labelIds: [$labelId], resources: [{ name: "Design" }], projectIds: [$projectId], teamIds: [$teamId] }) { initiative { priority leadTeam { id } labels { id } resources projects { id } } } }`,
      { labelId: label.data!.labelCreate.label.id, teamId, projectId: source.id },
    );
    expect(initiative.errors).toBeUndefined();
    expect(initiative.data!.initiativeCreate.initiative).toMatchObject({
      priority: 2,
      leadTeam: { id: teamId },
      labels: [{ id: label.data!.labelCreate.label.id }],
      resources: [{ name: "Design" }],
      projects: [{ id: source.id }],
    });
    const initiativeId = (await gql(app, `{ initiatives { id name } }`)).data!.initiatives.find(
      (item: { name: string }) => item.name === "Roadmap",
    ).id as string;
    const update = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateCreate(input: { initiativeId: $id, health: ON_TRACK, body: "Status" }) { initiativeUpdate { initiative { id } author { id } body } } }`,
      { id: initiativeId },
    );
    expect(update.errors).toBeUndefined();
    expect(update.data!.initiativeStatusUpdateCreate.initiativeUpdate.initiative.id).toBe(
      initiativeId,
    );
  });

  it("usa ACL de Project separada y conserva Initiative owner ACL", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const project = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "ACL project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: team.data!.team.id },
    );
    const projectId = project.data!.projectCreate.project.id as string;
    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "direct-project-member", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id as string;
    await gql(
      app,
      `mutation($id: ID!, $memberId: ID!) { projectUpdate(id: $id, input: { memberIds: [$memberId] }) { success } }`,
      { id: projectId, memberId },
    );
    const key = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "member-key" }) { key } }`,
      { actorId: memberId },
    );
    const viewed = await gql(
      app,
      `query($id: ID!) { project(id: $id) { id members { id } } }`,
      { id: projectId },
      key.data!.apiKeyCreate.key,
    );
    expect(viewed.errors).toBeUndefined();
    expect(viewed.data!.project.members).toEqual([{ id: memberId }]);
  });
});
