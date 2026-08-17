// PRB-262: todos los targetDate comparten validación DateTime.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("targetDate DateTime validation", () => {
  it("rechaza targetDate inválidos en create y update sin persistirlos", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id as string;

    const invalidProject = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: {
          name: "Invalid project target date", teamIds: [$teamId], targetDate: "not-a-date"
        }) { success }
      }`,
      { teamId },
    );
    expect(invalidProject.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const invalidLiteral = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: {
          name: "Invalid literal target date", teamIds: [$teamId], targetDate: 123
        }) { success }
      }`,
      { teamId },
    );
    expect(invalidLiteral.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const project = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: {
          name: "Valid project target date", teamIds: [$teamId], targetDate: "2026-09-01"
        }) { project { id targetDate } }
      }`,
      { teamId },
    );
    expect(project.errors).toBeUndefined();
    const projectId = project.data!.projectCreate.project.id as string;
    expect(project.data!.projectCreate.project.targetDate).toBe("2026-09-01");

    const invalidProjectUpdate = await gql(
      app,
      `mutation($id: ID!) {
        projectUpdate(id: $id, input: { targetDate: "not-a-date" }) { success }
      }`,
      { id: projectId },
    );
    expect(invalidProjectUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const invalidMilestone = await gql(
      app,
      `mutation($projectId: ID!) {
        milestoneCreate(input: {
          projectId: $projectId, name: "Invalid milestone target date", targetDate: "not-a-date"
        }) { success }
      }`,
      { projectId },
    );
    expect(invalidMilestone.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const milestone = await gql(
      app,
      `mutation($projectId: ID!) {
        milestoneCreate(input: {
          projectId: $projectId, name: "Valid milestone target date", targetDate: "2026-10-01"
        }) { milestone { id targetDate } }
      }`,
      { projectId },
    );
    expect(milestone.errors).toBeUndefined();
    const milestoneId = milestone.data!.milestoneCreate.milestone.id as string;
    expect(milestone.data!.milestoneCreate.milestone.targetDate).toBe("2026-10-01");

    const invalidMilestoneUpdate = await gql(
      app,
      `mutation($id: ID!) {
        milestoneUpdate(id: $id, input: { targetDate: "not-a-date" }) { success }
      }`,
      { id: milestoneId },
    );
    expect(invalidMilestoneUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const invalidInitiative = await gql(
      app,
      `mutation {
        initiativeCreate(input: { name: "Invalid initiative target date", targetDate: "not-a-date" }) { success }
      }`,
    );
    expect(invalidInitiative.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const initiative = await gql(
      app,
      `mutation {
        initiativeCreate(input: { name: "Valid initiative target date", targetDate: "2026-11-01" }) {
          initiative { id targetDate }
        }
      }`,
    );
    expect(initiative.errors).toBeUndefined();
    const initiativeId = initiative.data!.initiativeCreate.initiative.id as string;
    expect(initiative.data!.initiativeCreate.initiative.targetDate).toBe("2026-11-01");

    const invalidInitiativeUpdate = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { targetDate: "not-a-date" }) { success }
      }`,
      { id: initiativeId },
    );
    expect(invalidInitiativeUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const projectAfter = await gql(
      app,
      `query($id: ID!) { project(id: $id) { targetDate milestones { id targetDate } } }`,
      { id: projectId },
    );
    expect(projectAfter.data!.project).toMatchObject({
      targetDate: "2026-09-01",
      milestones: [{ id: milestoneId, targetDate: "2026-10-01" }],
    });
    const initiativeAfter = await gql(
      app,
      `query($id: ID!) { initiative(id: $id) { targetDate } }`,
      { id: initiativeId },
    );
    expect(initiativeAfter.data!.initiative.targetDate).toBe("2026-11-01");

    const projects = await gql(
      app,
      `query($teamId: ID!) { projects(team: $teamId) { name targetDate } }`,
      { teamId },
    );
    expect(projects.data!.projects).not.toContainEqual(
      expect.objectContaining({ name: "Invalid project target date" }),
    );
    const initiatives = await gql(app, `{ initiatives { name targetDate } }`);
    expect(initiatives.data!.initiatives).not.toContainEqual(
      expect.objectContaining({ name: "Invalid initiative target date" }),
    );
  });
});
