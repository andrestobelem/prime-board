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

  it("refluye la cadencia alrededor de un ciclo manual en SQLite", async () => {
    const day = 24 * 60 * 60 * 1000;
    const scenarios = [
      { key: "R622B", name: "Manual before", position: "before" },
      { key: "R622M", name: "Manual between", position: "between" },
      { key: "R622A", name: "Manual after", position: "after" },
    ] as const;

    for (const scenario of scenarios) {
      const createdTeam = await gql(
        app,
        `mutation($name: String!, $key: String!) {
          teamCreate(input: {
            name: $name, key: $key, timezone: "UTC", cyclesEnabled: true,
            cycleDurationWeeks: 1, cycleStartDay: WEDNESDAY,
            cycleCooldownDays: 0, cycleUpcomingCount: 3
          }) { team { id } }
        }`,
        { name: scenario.name, key: scenario.key },
      );
      expect(createdTeam.errors).toBeUndefined();
      const teamId = createdTeam.data!.teamCreate.team.id as string;

      const seeded = await gql(
        app,
        `mutation($teamId: ID!) {
          cycleCreateFromCadence(input: { teamId: $teamId }) {
            cycle { id number startsAt endsAt cadenceSource }
          }
        }`,
        { teamId },
      );
      expect(seeded.errors).toBeUndefined();

      const initial = await gql(
        app,
        `query($teamId: ID!) {
          cycles(teamId: $teamId) {
            id number startsAt endsAt cadenceSource archivedAt
          }
        }`,
        { teamId },
      );
      expect(initial.errors).toBeUndefined();
      const initialCycles = initial.data!.cycles as Array<{
        id: string;
        number: number;
        startsAt: string;
        endsAt: string;
        cadenceSource: string;
        archivedAt: string | null;
      }>;
      expect(initialCycles).toHaveLength(3);
      expect(initialCycles.map((cycle) => cycle.number)).toEqual([1, 2, 3]);

      const first = initialCycles[0]!;
      const second = initialCycles[1]!;
      const manualStartsAt =
        scenario.position === "before"
          ? new Date(Date.parse(first.startsAt) - 14 * day).toISOString()
          : scenario.position === "between"
            ? new Date(Date.parse(first.endsAt) + day).toISOString()
            : "2030-01-01T00:00:00.000Z";
      const manualEndsAt = new Date(Date.parse(manualStartsAt) + 6 * day).toISOString();
      const moved = await gql(
        app,
        `mutation($id: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleUpdate(id: $id, input: { startsAt: $startsAt, endsAt: $endsAt }) {
            cycle { id number startsAt endsAt cadenceSource }
          }
        }`,
        { id: second.id, startsAt: manualStartsAt, endsAt: manualEndsAt },
      );
      expect(moved.errors).toBeUndefined();
      expect(moved.data!.cycleUpdate.cycle).toMatchObject({
        id: second.id,
        number: 2,
        startsAt: manualStartsAt,
        endsAt: manualEndsAt,
        cadenceSource: "MANUAL",
      });

      const changedSettings = await gql(
        app,
        `mutation($id: ID!) {
          teamUpdate(id: $id, input: { cycleStartDay: THURSDAY }) {
            team { id cycleStartDay }
          }
        }`,
        { id: teamId },
      );
      expect(changedSettings.errors).toBeUndefined();

      const after = await gql(
        app,
        `query($teamId: ID!) {
          cycles(teamId: $teamId) {
            id number startsAt endsAt cadenceSource archivedAt
          }
        }`,
        { teamId },
      );
      expect(after.errors).toBeUndefined();
      const cycles = after.data!.cycles as typeof initialCycles;
      expect(cycles).toHaveLength(3);
      expect(cycles.map((cycle) => cycle.id)).toEqual(initialCycles.map((cycle) => cycle.id));
      expect(cycles.map((cycle) => cycle.number)).toEqual([1, 2, 3]);
      expect(cycles.every((cycle) => cycle.archivedAt === null)).toBe(true);

      const manual = cycles.find((cycle) => cycle.number === 2)!;
      const cadence = cycles.filter((cycle) => cycle.cadenceSource === "CADENCE");
      expect(manual).toMatchObject({
        id: second.id,
        startsAt: manualStartsAt,
        endsAt: manualEndsAt,
        cadenceSource: "MANUAL",
      });
      expect(cadence).toHaveLength(2);
      const byDate = [...cycles].sort(
        (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.number - b.number,
      );
      for (let index = 1; index < byDate.length; index += 1) {
        expect(Date.parse(byDate[index - 1]!.endsAt)).toBeLessThanOrEqual(
          Date.parse(byDate[index]!.startsAt),
        );
      }
      if (scenario.position === "before") {
        expect(Date.parse(manual.endsAt)).toBeLessThanOrEqual(Date.parse(first.startsAt));
      } else {
        const lastCadence = cycles.find((cycle) => cycle.number === 3)!;
        expect(Date.parse(first.endsAt)).toBeLessThanOrEqual(Date.parse(manual.startsAt));
        expect(Date.parse(manual.endsAt)).toBeLessThanOrEqual(Date.parse(lastCadence.startsAt));
      }
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
