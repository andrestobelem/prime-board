// PRB-203: ciclos — CRUD GraphQL y asignación de issues.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("cycles", () => {
  it("crea un ciclo de team, lo lista y asigna un issue", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;

    const created = await gql(
      app,
      `
      mutation($input: CycleCreateInput!) {
        cycleCreate(input: $input) {
          success
          cycle {
            id
            name
            number
            state
            startsAt
            endsAt
            team { id }
          }
        }
      }
    `,
      {
        input: {
          teamId,
          name: "Cycle 1",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-08-14T23:59:59.000Z",
        },
      },
    );

    expect(created.errors).toBeUndefined();
    const cycle = created.data!.cycleCreate.cycle;
    expect(cycle).toMatchObject({
      name: "Cycle 1",
      number: 1,
      state: "UPCOMING",
      team: { id: teamId },
    });

    const listed = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id name number } }`,
      { teamId },
    );
    expect(listed.data!.cycles).toEqual([{ id: cycle.id, name: "Cycle 1", number: 1 }]);

    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "In cycle" }) {
        issue { id identifier }
      } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;

    const assigned = await gql(
      app,
      `
      mutation($id: ID!, $cycleId: ID!) {
        issueUpdate(id: $id, input: { cycleId: $cycleId }) {
          issue { id cycle { id name } }
        }
      }
    `,
      { id: issueId, cycleId: cycle.id },
    );
    expect(assigned.errors).toBeUndefined();
    expect(assigned.data!.issueUpdate.issue.cycle).toEqual({
      id: cycle.id,
      name: "Cycle 1",
    });

    const filtered = await gql(
      app,
      `
      query($cycleId: ID!) {
        issues(filter: { cycle: { eq: $cycleId } }) {
          nodes { identifier title }
        }
      }
    `,
      { cycleId: cycle.id },
    );
    expect(filtered.data!.issues.nodes).toEqual([
      { identifier: issue.data!.issueCreate.issue.identifier, title: "In cycle" },
    ]);
  });

  it("actualiza estado del ciclo y rechaza fechas inválidas", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const created = await gql(
      app,
      `
      mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Sprint", startsAt: "2026-09-01", endsAt: "2026-09-14"
        }) { cycle { id } }
      }
    `,
      { teamId: team.data!.team.id },
    );
    const id = created.data!.cycleCreate.cycle.id;

    const started = await gql(
      app,
      `mutation($id: ID!) {
        cycleUpdate(id: $id, input: { state: ACTIVE }) { cycle { id state name } }
      }`,
      { id },
    );
    expect(started.data!.cycleUpdate.cycle).toMatchObject({ id, state: "ACTIVE", name: "Sprint" });

    const badDates = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Bad", startsAt: "2026-10-10", endsAt: "2026-10-01"
        }) { success }
      }`,
      { teamId: team.data!.team.id },
    );
    expect(badDates.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("actualiza updatedAt de issues al borrar un ciclo", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const created = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Deleted cycle", startsAt: "2027-01-01", endsAt: "2027-01-14"
        }) { cycle { id } }
      }`,
      { teamId: team.data!.team.id },
    );
    const cycleId = created.data!.cycleCreate.cycle.id;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Cycle timestamp" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($issueId: ID!, $cycleId: ID!) {
        issueUpdate(id: $issueId, input: { cycleId: $cycleId }) { success }
      }`,
      { issueId, cycleId },
    );
    const before = await gql(app, `query($id: ID!) { issue(id: $id) { updatedAt cycle { id } } }`, {
      id: issueId,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const deleted = await gql(app, `mutation($id: ID!) { cycleDelete(id: $id) { success } }`, {
      id: cycleId,
    });
    expect(deleted.errors).toBeUndefined();
    const after = await gql(app, `query($id: ID!) { issue(id: $id) { updatedAt cycle { id } } }`, {
      id: issueId,
    });
    expect(after.data!.issue.cycle).toBeNull();
    expect(after.data!.issue.updatedAt).not.toBe(before.data!.issue.updatedAt);
  });

  it("rechaza DateTime no parseables y no persiste cambios inválidos", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;

    const invalidCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Invalid DateTime", startsAt: "not-a-date", endsAt: "zzz"
        }) { success }
      }`,
      { teamId },
    );
    expect(invalidCreate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const invalidOrder = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Invalid Offset Order",
          startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-01T01:00:00+03:00"
        }) { success }
      }`,
      { teamId },
    );
    expect(invalidOrder.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const created = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Valid DateTime", startsAt: "2026-11-01", endsAt: "2026-11-14"
        }) { cycle { id startsAt endsAt } }
      }`,
      { teamId },
    );
    const cycle = created.data!.cycleCreate.cycle;

    const invalidUpdate = await gql(
      app,
      `mutation($id: ID!) {
        cycleUpdate(id: $id, input: { startsAt: "not-a-date" }) { success }
      }`,
      { id: cycle.id },
    );
    expect(invalidUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const listed = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id name startsAt endsAt } }`,
      { teamId },
    );
    expect(listed.data!.cycles).not.toContainEqual(
      expect.objectContaining({ name: "Invalid DateTime" }),
    );
    expect(listed.data!.cycles).toContainEqual({
      id: cycle.id,
      name: "Valid DateTime",
      startsAt: "2026-11-01",
      endsAt: "2026-11-14",
    });
  });

  it("aplica auto-add al crear un ciclo ACTIVE y respeta la configuración", async () => {
    const enabledTeam = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Auto-add direct", key: "AUT", cyclesEnabled: true,
          cycleUpcomingCount: 3, cycleAutoAddEnabled: true
        }) { team { id states { id type } } }
      }`,
    );
    expect(enabledTeam.errors).toBeUndefined();
    const enabled = enabledTeam.data!.teamCreate.team;
    const startedState = enabled.states.find((state: { type: string }) => state.type === "STARTED");
    expect(startedState).toBeDefined();
    const issue = await gql(
      app,
      `mutation($stateId: ID!) {
        issueCreate(input: { teamKey: "AUT", title: "Auto-add direct issue", stateId: $stateId }) {
          issue { id cycle { id } }
        }
      }`,
      { stateId: startedState.id },
    );
    expect(issue.errors).toBeUndefined();
    expect(issue.data!.issueCreate.issue.cycle).toBeNull();

    const cycle = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Active direct", state: ACTIVE,
          startsAt: "2026-09-01", endsAt: "2026-09-14"
        }) { cycle { id number state } }
      }`,
      { teamId: enabled.id },
    );
    expect(cycle.errors).toBeUndefined();
    expect(cycle.data!.cycleCreate.cycle.state).toBe("ACTIVE");
    const horizon = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { number state cadenceSource } }`,
      { teamId: enabled.id },
    );
    expect(horizon.errors).toBeUndefined();
    expect(horizon.data!.cycles).toHaveLength(4);
    expect(
      horizon.data!.cycles.filter((item: { state: string }) => item.state === "UPCOMING"),
    ).toHaveLength(3);
    expect(
      horizon
        .data!.cycles.filter((item: { state: string }) => item.state === "UPCOMING")
        .every((item: { cadenceSource: string }) => item.cadenceSource === "CADENCE"),
    ).toBe(true);

    const assigned = await gql(
      app,
      `query($id: ID!) {
        issue(id: $id) {
          cycle { id number }
          activity { type payload }
        }
      }`,
      { id: issue.data!.issueCreate.issue.id },
    );
    expect(assigned.errors).toBeUndefined();
    expect(assigned.data!.issue.cycle).toEqual({
      id: cycle.data!.cycleCreate.cycle.id,
      number: cycle.data!.cycleCreate.cycle.number,
    });
    expect(assigned.data!.issue.activity).toContainEqual({
      type: "cycle_changed",
      payload: {
        from: null,
        to: `AUT/${cycle.data!.cycleCreate.cycle.number}`,
        reason: "cycle_auto_add",
      },
    });

    const disabledTeam = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Auto-add off", key: "AUO", cyclesEnabled: true,
          cycleUpcomingCount: 0, cycleAutoAddEnabled: false
        }) { team { id states { id type } } }
      }`,
    );
    expect(disabledTeam.errors).toBeUndefined();
    const disabled = disabledTeam.data!.teamCreate.team;
    const disabledStarted = disabled.states.find(
      (state: { type: string }) => state.type === "STARTED",
    );
    const disabledIssue = await gql(
      app,
      `mutation($stateId: ID!) {
        issueCreate(input: { teamKey: "AUO", title: "Auto-add disabled", stateId: $stateId }) {
          issue { id }
        }
      }`,
      { stateId: disabledStarted.id },
    );
    const disabledCycle = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Active without auto-add", state: ACTIVE,
          startsAt: "2026-10-01", endsAt: "2026-10-14"
        }) { cycle { id } }
      }`,
      { teamId: disabled.id },
    );
    expect(disabledCycle.errors).toBeUndefined();
    const disabledAfter = await gql(app, `query($id: ID!) { issue(id: $id) { cycle { id } } }`, {
      id: disabledIssue.data!.issueCreate.issue.id,
    });
    expect(disabledAfter.data!.issue.cycle).toBeNull();
  });

  it("repone el horizonte tras borrar un ciclo generado y conserva los manuales", async () => {
    const teamResult = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Cycle horizon deletion", key: "HDEL", cyclesEnabled: true,
          cycleUpcomingCount: 3
        }) { team { id } }
      }`,
    );
    expect(teamResult.errors).toBeUndefined();
    const teamId = teamResult.data!.teamCreate.team.id as string;
    const initial = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id number startsAt endsAt cadenceSource } }`,
      { teamId },
    );
    expect(initial.errors).toBeUndefined();
    const generated = initial.data!.cycles as Array<{
      id: string;
      number: number;
      startsAt: string;
      endsAt: string;
      cadenceSource: string;
    }>;
    expect(generated).toHaveLength(3);
    expect(generated.every((cycle) => cycle.cadenceSource === "CADENCE")).toBe(true);

    const manual = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Manual stays", startsAt: "2035-01-01", endsAt: "2035-01-14"
        }) { cycle { id startsAt endsAt cadenceSource } }
      }`,
      { teamId },
    );
    expect(manual.errors).toBeUndefined();
    const manualCycle = manual.data!.cycleCreate.cycle;
    const deleted = await gql(app, `mutation($id: ID!) { cycleDelete(id: $id) { success } }`, {
      id: generated[0]!.id,
    });
    expect(deleted.errors).toBeUndefined();

    const after = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id number startsAt endsAt cadenceSource } }`,
      { teamId },
    );
    expect(after.errors).toBeUndefined();
    const cycles = after.data!.cycles as Array<{
      id: string;
      number: number;
      startsAt: string;
      endsAt: string;
      cadenceSource: string;
    }>;
    expect(cycles).toHaveLength(3);
    expect(cycles.filter((cycle) => cycle.cadenceSource === "CADENCE")).toHaveLength(2);
    expect(cycles).toContainEqual(
      expect.objectContaining({
        id: manualCycle.id,
        startsAt: manualCycle.startsAt,
        endsAt: manualCycle.endsAt,
        cadenceSource: "MANUAL",
      }),
    );
    expect(cycles).not.toContainEqual(expect.objectContaining({ id: generated[0]!.id }));
  });

  it("mantiene el orden numérico al reprogramar la cadencia", async () => {
    const teamResult = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "Cycle sequence order", key: "HSEQ", cyclesEnabled: true,
          cycleDurationWeeks: 1, cycleUpcomingCount: 3
        }) { team { id } }
      }`,
    );
    expect(teamResult.errors).toBeUndefined();
    const teamId = teamResult.data!.teamCreate.team.id as string;
    const initial = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id number startsAt endsAt cadenceSource } }`,
      { teamId },
    );
    const initialCycles = initial.data!.cycles as Array<{
      id: string;
      number: number;
      startsAt: string;
      endsAt: string;
      cadenceSource: string;
    }>;
    const second = initialCycles.find((cycle) => cycle.number === 2)!;
    const manualStartsAt = "2030-01-01T00:00:00.000Z";
    const manualEndsAt = "2030-01-14T23:59:59.000Z";
    const updated = await gql(
      app,
      `mutation($id: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
        cycleUpdate(id: $id, input: { startsAt: $startsAt, endsAt: $endsAt }) {
          cycle { id number startsAt endsAt cadenceSource }
        }
      }`,
      { id: second.id, startsAt: manualStartsAt, endsAt: manualEndsAt },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.cycleUpdate.cycle).toMatchObject({
      id: second.id,
      number: 2,
      startsAt: manualStartsAt,
      endsAt: manualEndsAt,
      cadenceSource: "MANUAL",
    });
    const after = await gql(
      app,
      `query($teamId: ID!) { cycles(teamId: $teamId) { id number startsAt endsAt cadenceSource } }`,
      { teamId },
    );
    const cycles = after.data!.cycles as typeof initialCycles;
    expect(cycles.map((cycle) => cycle.number)).toEqual([1, 2, 3]);
    expect(cycles.find((cycle) => cycle.number === 2)).toMatchObject({
      id: second.id,
      startsAt: manualStartsAt,
      endsAt: manualEndsAt,
      cadenceSource: "MANUAL",
    });
    const byDate = [...cycles].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    expect(byDate.map((cycle) => cycle.number)).toEqual([1, 2, 3]);
    for (let index = 1; index < byDate.length; index += 1) {
      expect(Date.parse(byDate[index - 1]!.endsAt)).toBeLessThanOrEqual(
        Date.parse(byDate[index]!.startsAt),
      );
    }
  });

  it("serializa la creación concurrente de ciclos activos y conserva count=0", async () => {
    const activeTeam = await gql(
      app,
      `mutation {
        teamCreate(input: { name: "Active invariant", key: "ACT" }) { team { id } }
      }`,
    );
    const activeTeamId = activeTeam.data!.teamCreate.team.id;
    const createActive = (name: string) =>
      gql(
        app,
        `mutation($teamId: ID!, $name: String!) {
          cycleCreate(input: {
            teamId: $teamId, name: $name, state: ACTIVE,
            startsAt: "2031-01-01", endsAt: "2031-01-14"
          }) { success cycle { id state } }
        }`,
        { teamId: activeTeamId, name },
      );
    const activeResults = await Promise.all([createActive("Active A"), createActive("Active B")]);
    expect(activeResults.filter((result) => !result.errors).length).toBe(1);
    expect(
      activeResults
        .filter((result) => result.errors)
        .map((result) => result.errors?.[0]?.extensions?.code),
    ).toEqual(["VALIDATION_FAILED"]);

    const zeroTeam = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "No generated cycles", key: "ZERO", cyclesEnabled: true,
          cycleUpcomingCount: 0
        }) { team { id cycleUpcomingCount } }
      }`,
    );
    const zeroTeamId = zeroTeam.data!.teamCreate.team.id;
    const requested = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreateFromCadence(input: { teamId: $teamId, name: "Explicit zero" }) {
          cycle { name state cadenceSource archivedAt }
        }
      }`,
      { teamId: zeroTeamId },
    );
    expect(requested.errors).toBeUndefined();
    expect(requested.data!.cycleCreateFromCadence.cycle).toMatchObject({
      name: "Explicit zero",
      state: "UPCOMING",
      cadenceSource: "MANUAL",
      archivedAt: null,
    });
  });
});
