// PRB-263: autorización de la configuración de teams.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

type Setup = {
  targetTeamId: string;
  otherTeamId: string;
  targetStateId: string;
  targetLabelId: string;
  targetCycleId: string;
  otherStateId: string;
  otherLabelId: string;
  otherCycleId: string;
  ownerKey: string;
  memberKey: string;
  outsiderKey: string;
};

let setup: Setup;

async function createActorKey(name: string): Promise<string> {
  const actor = await gql(
    app,
    `mutation($name: String!) {
      actorCreate(input: { name: $name, type: AGENT }) { actor { id } }
    }`,
    { name },
  );
  const actorId = actor.data!.actorCreate.actor.id as string;
  const key = await gql(
    app,
    `mutation($actorId: ID!) {
      apiKeyCreate(input: { actorId: $actorId, name: "${name} key" }) { key }
    }`,
    { actorId },
  );
  return key.data!.apiKeyCreate.key as string;
}

async function expectError(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
  code: string,
): Promise<void> {
  const result = await gql(app, query, variables, apiKey);
  expect(result.errors?.[0]?.extensions?.code).toBe(code);
}

async function expectUnauthorized(
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
): Promise<void> {
  await expectError(query, variables, apiKey, "UNAUTHORIZED");
}

beforeAll(async () => {
  const target = await gql(
    app,
    `mutation { teamCreate(input: { name: "Authorization target", key: "AU" }) { team { id } } }`,
  );
  const targetTeamId = target.data!.teamCreate.team.id as string;
  const other = await gql(
    app,
    `mutation { teamCreate(input: { name: "Other authorization target", key: "AX" }) { team { id } } }`,
  );
  const otherTeamId = other.data!.teamCreate.team.id as string;

  const ownerKey = await createActorKey("team-owner");
  const memberKey = await createActorKey("team-member");
  const outsiderKey = await createActorKey("team-outsider");

  const actors = await gql(app, `{ actors { id name } }`);
  const ownerId = actors.data!.actors.find(
    (actor: { name: string }) => actor.name === "team-owner",
  ).id;
  const memberId = actors.data!.actors.find(
    (actor: { name: string }) => actor.name === "team-member",
  ).id;
  const membership = await gql(
    app,
    `mutation($teamId: ID!, $actorId: ID!, $role: TeamMembershipRole!) {
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: $role }) { success }
    }`,
    { teamId: targetTeamId, actorId: ownerId, role: "OWNER" },
  );
  expect(membership.errors).toBeUndefined();
  const memberMembership = await gql(
    app,
    `mutation($teamId: ID!, $actorId: ID!, $role: TeamMembershipRole!) {
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: $role }) { success }
    }`,
    { teamId: targetTeamId, actorId: memberId, role: "MEMBER" },
  );
  expect(memberMembership.errors).toBeUndefined();

  const members = await gql(
    app,
    `query($id: ID!) { team(id: $id) { memberships { id actor { name } role } } }`,
    { id: targetTeamId },
    ownerKey,
  );
  const adminMembershipId = members.data!.team.memberships.find(
    (membership: { actor: { name: string } }) => membership.actor.name === "admin",
  ).id;
  const removed = await gql(
    app,
    `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
    { id: adminMembershipId },
    ownerKey,
  );
  expect(removed.errors).toBeUndefined();

  const targetResources = await gql(
    app,
    `mutation($teamId: ID!) {
      workflowStateCreate(input: {
        teamId: $teamId, name: "Protected State", type: UNSTARTED, color: "#123456"
      }) { workflowState { id } }
      labelCreate(input: { teamId: $teamId, name: "Protected Label" }) { label { id } }
      cycleCreate(input: {
        teamId: $teamId, name: "Protected Cycle", startsAt: "2027-01-01", endsAt: "2027-01-14"
      }) { cycle { id } }
    }`,
    { teamId: targetTeamId },
  );
  const targetStateId = targetResources.data!.workflowStateCreate.workflowState.id as string;
  const targetLabelId = targetResources.data!.labelCreate.label.id as string;
  const targetCycleId = targetResources.data!.cycleCreate.cycle.id as string;

  const otherResources = await gql(
    app,
    `mutation($teamId: ID!) {
      workflowStateCreate(input: {
        teamId: $teamId, name: "Other Protected State", type: UNSTARTED, color: "#123456"
      }) { workflowState { id } }
      labelCreate(input: { teamId: $teamId, name: "Other Protected Label" }) { label { id } }
      cycleCreate(input: {
        teamId: $teamId, name: "Other Protected Cycle", startsAt: "2027-02-01", endsAt: "2027-02-14"
      }) { cycle { id } }
    }`,
    { teamId: otherTeamId },
  );
  setup = {
    targetTeamId,
    otherTeamId,
    targetStateId,
    targetLabelId,
    targetCycleId,
    otherStateId: otherResources.data!.workflowStateCreate.workflowState.id as string,
    otherLabelId: otherResources.data!.labelCreate.label.id as string,
    otherCycleId: otherResources.data!.cycleCreate.cycle.id as string,
    ownerKey,
    memberKey,
    outsiderKey,
  };
});

describe("autorización de configuración de teams", () => {
  it("rechaza a outsiders y members en todas las mutations de configuración", async () => {
    const deniedMutations = [
      [
        `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.targetTeamId },
      ],
      [
        `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "Denied state", type: UNSTARTED }) { success } }`,
        { teamId: setup.targetTeamId },
      ],
      [
        `mutation($id: ID!) { workflowStateUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.targetStateId },
      ],
      [
        `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`,
        { id: setup.targetStateId },
      ],
      [
        `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "Denied label" }) { success } }`,
        { teamId: setup.targetTeamId },
      ],
      [
        `mutation($id: ID!) { labelUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.targetLabelId },
      ],
      [`mutation($id: ID!) { labelDelete(id: $id) { success } }`, { id: setup.targetLabelId }],
      [
        `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "Denied cycle", startsAt: "2027-03-01", endsAt: "2027-03-14" }) { success } }`,
        { teamId: setup.targetTeamId },
      ],
      [
        `mutation($id: ID!) { cycleUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.targetCycleId },
      ],
      [`mutation($id: ID!) { cycleDelete(id: $id) { success } }`, { id: setup.targetCycleId }],
      [`mutation { labelCreate(input: { name: "Denied workspace label" }) { success } }`, {}],
    ] as const;

    for (const apiKey of [setup.outsiderKey, setup.memberKey]) {
      for (const [query, variables] of deniedMutations) {
        await expectUnauthorized(query, variables, apiKey);
      }
    }

    const snapshot = await gql(
      app,
      `query($id: ID!) {
        team(id: $id) {
          name
          states { id name }
          labels { id name }
          cycles { id name }
        }
      }`,
      { id: setup.targetTeamId },
    );
    expect(snapshot.data!.team.name).toBe("Authorization target");
    expect(snapshot.data!.team.states).toContainEqual({
      id: setup.targetStateId,
      name: "Protected State",
    });
    expect(snapshot.data!.team.labels).toContainEqual({
      id: setup.targetLabelId,
      name: "Protected Label",
    });
    expect(snapshot.data!.team.cycles).toContainEqual({
      id: setup.targetCycleId,
      name: "Protected Cycle",
    });
    expect(snapshot.data!.team.labels).not.toContainEqual(
      expect.objectContaining({ name: "Denied label" }),
    );
  });

  it("permite al owner gestionar su team pero no labels del workspace", async () => {
    const teamUpdate = await gql(
      app,
      `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "Owner updated" }) { success } }`,
      { id: setup.targetTeamId },
      setup.ownerKey,
    );
    expect(teamUpdate.errors).toBeUndefined();

    const state = await gql(
      app,
      `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "Owner state", type: UNSTARTED }) { workflowState { id } } }`,
      { teamId: setup.targetTeamId },
      setup.ownerKey,
    );
    expect(state.errors).toBeUndefined();
    const stateId = state.data!.workflowStateCreate.workflowState.id as string;
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { workflowStateUpdate(id: $id, input: { name: "Owner renamed state" }) { success } }`,
          { id: stateId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`,
          { id: stateId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();

    const label = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "Owner label" }) { label { id } } }`,
      { teamId: setup.targetTeamId },
      setup.ownerKey,
    );
    expect(label.errors).toBeUndefined();
    const labelId = label.data!.labelCreate.label.id as string;
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { labelUpdate(id: $id, input: { name: "Owner renamed label" }) { success } }`,
          { id: labelId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { labelDelete(id: $id) { success } }`,
          { id: labelId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();
    await expectUnauthorized(
      `mutation { labelCreate(input: { name: "Owner workspace label" }) { success } }`,
      {},
      setup.ownerKey,
    );

    const cycle = await gql(
      app,
      `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "Owner cycle", startsAt: "2027-04-01", endsAt: "2027-04-14" }) { cycle { id } } }`,
      { teamId: setup.targetTeamId },
      setup.ownerKey,
    );
    expect(cycle.errors).toBeUndefined();
    const cycleId = cycle.data!.cycleCreate.cycle.id as string;
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { cycleUpdate(id: $id, input: { name: "Owner renamed cycle" }) { success } }`,
          { id: cycleId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();
    expect(
      (
        await gql(
          app,
          `mutation($id: ID!) { cycleDelete(id: $id) { success } }`,
          { id: cycleId },
          setup.ownerKey,
        )
      ).errors,
    ).toBeUndefined();
  });

  it("mantiene el bypass del admin y evita el acceso cross-team del owner", async () => {
    const crossTeam = [
      [
        `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.otherTeamId },
      ],
      [
        `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "Nope", type: UNSTARTED }) { success } }`,
        { teamId: setup.otherTeamId },
      ],
      [
        `mutation($id: ID!) { workflowStateUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.otherStateId },
      ],
      [
        `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`,
        { id: setup.otherStateId },
      ],
      [
        `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "Nope" }) { success } }`,
        { teamId: setup.otherTeamId },
      ],
      [
        `mutation($id: ID!) { labelUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.otherLabelId },
      ],
      [`mutation($id: ID!) { labelDelete(id: $id) { success } }`, { id: setup.otherLabelId }],
      [
        `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "Nope", startsAt: "2027-05-01", endsAt: "2027-05-14" }) { success } }`,
        { teamId: setup.otherTeamId },
      ],
      [
        `mutation($id: ID!) { cycleUpdate(id: $id, input: { name: "Nope" }) { success } }`,
        { id: setup.otherCycleId },
      ],
      [`mutation($id: ID!) { cycleDelete(id: $id) { success } }`, { id: setup.otherCycleId }],
    ] as const;
    for (const [query, variables] of crossTeam) {
      await expectUnauthorized(query, variables, setup.ownerKey);
    }

    const adminUpdate = await gql(
      app,
      `mutation($id: ID!) { teamUpdate(id: $id, input: { description: "Admin bypass" }) { success } }`,
      { id: setup.targetTeamId },
    );
    expect(adminUpdate.errors).toBeUndefined();
    const adminLabel = await gql(
      app,
      `mutation { labelCreate(input: { name: "Admin workspace label" }) { label { id teamId } } }`,
    );
    expect(adminLabel.errors).toBeUndefined();
    expect(adminLabel.data!.labelCreate.label.teamId).toBeNull();
    const deleted = await gql(app, `mutation($id: ID!) { labelDelete(id: $id) { success } }`, {
      id: adminLabel.data!.labelCreate.label.id,
    });
    expect(deleted.errors).toBeUndefined();
  });

  it("restringe el carry-over de ciclos al owner del team", async () => {
    const destination = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: { teamId: $teamId, name: "Carry destination", startsAt: "2027-06-01", endsAt: "2027-06-14" }) { cycle { id } }
      }`,
      { teamId: setup.targetTeamId },
    );
    const destinationId = destination.data!.cycleCreate.cycle.id as string;
    const issue = await gql(
      app,
      `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "Carry issue" }) { issue { id } } }`,
      { teamId: setup.targetTeamId },
    );
    const issueId = issue.data!.issueCreate.issue.id as string;
    const assigned = await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) { issueUpdate(id: $id, input: { cycleId: $cycleId }) { success } }`,
      { id: issueId, cycleId: setup.targetCycleId },
    );
    expect(assigned.errors).toBeUndefined();

    const denied = await gql(
      app,
      `mutation($from: ID!, $to: ID!) { cycleCarryOver(fromCycleId: $from, toCycleId: $to) { success } }`,
      { from: setup.targetCycleId, to: destinationId },
      setup.outsiderKey,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const unchanged = await gql(app, `query($id: ID!) { issue(id: $id) { cycle { id } } }`, {
      id: issueId,
    });
    expect(unchanged.data!.issue.cycle.id).toBe(setup.targetCycleId);

    const allowed = await gql(
      app,
      `mutation($from: ID!, $to: ID!) { cycleCarryOver(fromCycleId: $from, toCycleId: $to) { success movedIssues } }`,
      { from: setup.targetCycleId, to: destinationId },
      setup.ownerKey,
    );
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data!.cycleCarryOver.movedIssues).toBe(1);
  });

  it("conserva NOT_FOUND para recursos inexistentes", async () => {
    await expectError(
      `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "Nope" }) { success } }`,
      { id: "missing-team" },
      setup.outsiderKey,
      "NOT_FOUND",
    );
  });
});
