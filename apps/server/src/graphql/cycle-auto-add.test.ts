// Regresiones de PRB-626: auto-add al crear o activar Issues y al activar el setting.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

async function createTeam(key: string, autoAddEnabled: boolean) {
  const result = await gql(
    app,
    `mutation($key: String!, $autoAdd: Boolean!) {
      teamCreate(input: {
        name: $key, key: $key, cyclesEnabled: true,
        cycleUpcomingCount: 0, cycleAutoAddEnabled: $autoAdd
      }) { team { id states { id type } } }
    }`,
    { key, autoAdd: autoAddEnabled },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.teamCreate.team;
}

async function createActiveCycle(teamId: string, name: string) {
  const result = await gql(
    app,
    `mutation($teamId: ID!, $name: String!) {
      cycleCreate(input: {
        teamId: $teamId, name: $name, state: ACTIVE,
        startsAt: "2026-01-01", endsAt: "2026-01-14"
      }) { cycle { id state } }
    }`,
    { teamId, name },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreate.cycle;
}

function stateId(team: { states: Array<{ id: string; type: string }> }, type: string): string {
  const state = team.states.find((candidate) => candidate.type === type);
  if (!state) throw new Error(`Missing workflow state: ${type}`);
  return state.id;
}

describe("cycle auto-add", () => {
  it("asigna el Cycle al crear una Issue Started", async () => {
    const team = await createTeam("CA1", true);
    const cycle = await createActiveCycle(team.id, "Creation target");
    const result = await gql(
      app,
      `mutation($teamId: ID!, $stateId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Created started", stateId: $stateId }) {
          issue { id cycle { id } activity { type payload } }
        }
      }`,
      { teamId: team.id, stateId: stateId(team, "STARTED") },
    );

    expect(result.errors).toBeUndefined();
    const issue = result.data!.issueCreate.issue;
    expect(issue.cycle).toEqual({ id: cycle.id });
    expect(issue.activity).toContainEqual(
      expect.objectContaining({
        type: "cycle_changed",
        payload: expect.objectContaining({ reason: "cycle_auto_add" }),
      }),
    );
  });

  it("asigna el Cycle al pasar una Issue a Started sin sobrescribir uno explícito", async () => {
    const team = await createTeam("CA2", true);
    const cycle = await createActiveCycle(team.id, "Activation target");
    const backlogId = stateId(team, "BACKLOG");
    const startedId = stateId(team, "STARTED");
    const unassigned = await gql(
      app,
      `mutation($teamId: ID!, $stateId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Activate me", stateId: $stateId }) {
          issue { id cycle { id } }
        }
      }`,
      { teamId: team.id, stateId: backlogId },
    );
    const issueId = unassigned.data!.issueCreate.issue.id;
    expect(unassigned.data!.issueCreate.issue.cycle).toBeNull();

    const activated = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { issue { cycle { id } state { type } } }
      }`,
      { id: issueId, stateId: startedId },
    );
    expect(activated.errors).toBeUndefined();
    expect(activated.data!.issueUpdate.issue.cycle).toEqual({ id: cycle.id });

    const explicit = await gql(
      app,
      `mutation($teamId: ID!, $stateId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Keep explicit", stateId: $stateId }) {
          issue { id }
        }
      }`,
      { teamId: team.id, stateId: backlogId, cycleId: cycle.id },
    );
    const explicitId = explicit.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) {
        issueUpdate(id: $id, input: { cycleId: $cycleId }) { issue { id } }
      }`,
      { id: explicitId, cycleId: cycle.id },
    );
    const explicitActivated = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { issue { cycle { id } } }
      }`,
      { id: explicitId, stateId: startedId },
    );
    expect(explicitActivated.data!.issueUpdate.issue.cycle).toEqual({ id: cycle.id });
  });

  it("asigna Issues existentes al activar cycleAutoAddEnabled", async () => {
    const team = await createTeam("CA3", false);
    const cycle = await createActiveCycle(team.id, "Setting target");
    const issueResult = await gql(
      app,
      `mutation($teamId: ID!, $stateId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Waiting for setting", stateId: $stateId }) {
          issue { id cycle { id } }
        }
      }`,
      { teamId: team.id, stateId: stateId(team, "STARTED") },
    );
    const issueId = issueResult.data!.issueCreate.issue.id;
    expect(issueResult.data!.issueCreate.issue.cycle).toBeNull();

    const updatedTeam = await gql(
      app,
      `mutation($id: ID!) {
        teamUpdate(id: $id, input: { cycleAutoAddEnabled: true }) {
          team { cycleAutoAddEnabled }
        }
      }`,
      { id: team.id },
    );
    expect(updatedTeam.errors).toBeUndefined();
    expect(updatedTeam.data!.teamUpdate.team.cycleAutoAddEnabled).toBe(true);

    const issue = await gql(app, `query($id: ID!) { issue(id: $id) { cycle { id } } }`, {
      id: issueId,
    });
    expect(issue.data!.issue.cycle).toEqual({ id: cycle.id });
  });
});
