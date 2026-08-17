// PRB-272: los proyectos y sus recursos dependientes respetan membership del team.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;
let milestoneId: string;
let projectUpdateId: string;
let outsiderKey: string;
let memberKey: string;
let targetTeamId: string;
let otherTeamId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(
    app,
    `mutation { teamCreate(input: { name: "Project ACL", key: "PA" }) { team { id } } }`,
  );
  const teamId = team.data!.teamCreate.team.id as string;
  targetTeamId = teamId;
  const otherTeam = await gql(app, `query { team(key: "PB") { id } }`);
  otherTeamId = otherTeam.data!.team.id as string;
  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "project-outsider", type: AGENT }) { actor { id } } }`,
  );
  const actorId = actor.data!.actorCreate.actor.id as string;
  const key = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "project outsider key" }) { key } }`,
    { actorId },
  );
  outsiderKey = key.data!.apiKeyCreate.key as string;
  const member = await gql(
    app,
    `mutation { actorCreate(input: { name: "project-member", type: AGENT }) { actor { id } } }`,
  );
  const memberId = member.data!.actorCreate.actor.id as string;
  const memberApiKey = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) {
      apiKeyCreate(input: { actorId: $actorId, name: "project member key" }) { key }
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
    }`,
    { actorId: memberId, teamId },
  );
  memberKey = memberApiKey.data!.apiKeyCreate.key as string;
  const project = await gql(
    app,
    `mutation($teamId: ID!) { projectCreate(input: { name: "Protected project", teamIds: [$teamId] }) { project { id } } }`,
    { teamId },
  );
  projectId = project.data!.projectCreate.project.id as string;
  const milestone = await gql(
    app,
    `mutation($projectId: ID!) { milestoneCreate(input: { projectId: $projectId, name: "Protected milestone" }) { milestone { id } } }`,
    { projectId },
  );
  milestoneId = milestone.data!.milestoneCreate.milestone.id as string;
  const update = await gql(
    app,
    `mutation($projectId: ID!) { projectUpdateCreate(input: { projectId: $projectId, health: ON_TRACK, body: "Protected update" }) { projectUpdate { id } } }`,
    { projectId },
  );
  projectUpdateId = update.data!.projectUpdateCreate.projectUpdate.id as string;
});

afterAll(() => app.stop());

describe("project authorization", () => {
  it("allows a team member to manage projects and dependent resources", async () => {
    const created = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "Member project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: targetTeamId },
      memberKey,
    );
    expect(created.errors).toBeUndefined();
    const memberProjectId = created.data!.projectCreate.project.id as string;

    const updated = await gql(
      app,
      `mutation($id: ID!) { projectUpdate(id: $id, input: { description: "Member managed" }) { success } }`,
      { id: memberProjectId },
      memberKey,
    );
    expect(updated.errors).toBeUndefined();
    const reassigned = await gql(
      app,
      `mutation($id: ID!, $teamId: ID!) { projectUpdate(id: $id, input: { teamIds: [$teamId] }) { success } }`,
      { id: memberProjectId, teamId: otherTeamId },
      memberKey,
    );
    expect(reassigned.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const archived = await gql(
      app,
      `mutation($id: ID!) { projectArchive(id: $id) { success } }`,
      { id: memberProjectId },
      memberKey,
    );
    expect(archived.errors).toBeUndefined();
    const unarchived = await gql(
      app,
      `mutation($id: ID!) { projectUnarchive(id: $id) { success } }`,
      { id: memberProjectId },
      memberKey,
    );
    expect(unarchived.errors).toBeUndefined();

    const milestone = await gql(
      app,
      `mutation($projectId: ID!) { milestoneCreate(input: { projectId: $projectId, name: "Member milestone" }) { milestone { id } } }`,
      { projectId: memberProjectId },
      memberKey,
    );
    expect(milestone.errors).toBeUndefined();
    const memberMilestoneId = milestone.data!.milestoneCreate.milestone.id as string;
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { milestoneUpdate(id: $id, input: { name: "Member milestone updated" }) { success } }`,
          { id: memberMilestoneId },
          memberKey,
        )
      ).errors,
    ).toBeUndefined();
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { milestoneDelete(id: $id) { success } }`,
          { id: memberMilestoneId },
          memberKey,
        )
      ).errors,
    ).toBeUndefined();

    const update = await gql(
      app,
      `mutation($projectId: ID!) { projectUpdateCreate(input: { projectId: $projectId, health: ON_TRACK, body: "Member update" }) { projectUpdate { id } } }`,
      { projectId: memberProjectId },
      memberKey,
    );
    expect(update.errors).toBeUndefined();
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { projectUpdateDelete(id: $id) { success } }`,
          { id: update.data!.projectUpdateCreate.projectUpdate.id },
          memberKey,
        )
      ).errors,
    ).toBeUndefined();
  });

  it("rejects an authenticated outsider from updating a project", async () => {
    const result = await gql(
      app,
      `mutation($id: ID!) { projectUpdate(id: $id, input: { name: "Tampered" }) { success } }`,
      { id: projectId },
      outsiderKey,
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const project = await gql(app, `query($id: ID!) { project(id: $id) { name } }`, {
      id: projectId,
    });
    expect(project.data!.project.name).toBe("Protected project");
  });

  it("rejects an authenticated outsider from archiving and mutating dependent resources", async () => {
    const mutations = [
      [
        `mutation($teamId: ID!) { projectCreate(input: { name: "Denied project", teamIds: [$teamId] }) { success } }`,
        { teamId: targetTeamId },
      ],
      [`mutation($id: ID!) { projectArchive(id: $id) { success } }`, { id: projectId }],
      [`mutation($id: ID!) { projectUnarchive(id: $id) { success } }`, { id: projectId }],
      [
        `mutation($projectId: ID!) { milestoneCreate(input: { projectId: $projectId, name: "Denied milestone" }) { success } }`,
        { projectId },
      ],
      [
        `mutation($id: ID!) { milestoneUpdate(id: $id, input: { name: "Tampered milestone" }) { success } }`,
        { id: milestoneId },
      ],
      [`mutation($id: ID!) { milestoneDelete(id: $id) { success } }`, { id: milestoneId }],
      [
        `mutation($projectId: ID!) { projectUpdateCreate(input: { projectId: $projectId, health: OFF_TRACK, body: "Denied update" }) { success } }`,
        { projectId },
      ],
      [`mutation($id: ID!) { projectUpdateDelete(id: $id) { success } }`, { id: projectUpdateId }],
    ] as const;

    for (const [query, variables] of mutations) {
      const result = await gql(app, query, variables, outsiderKey);
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    }

    const snapshot = await gql(
      app,
      `query($id: ID!) { project(id: $id) { name archivedAt milestones { id name } updates { id body } } }`,
      { id: projectId },
      outsiderKey,
    );
    expect(snapshot.data!.project).toEqual({
      name: "Protected project",
      archivedAt: null,
      milestones: [{ id: milestoneId, name: "Protected milestone" }],
      updates: [{ id: projectUpdateId, body: "Protected update" }],
    });
  });
});
