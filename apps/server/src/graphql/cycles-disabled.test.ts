// PRB-627: desactivar Cycles retira todos los futuros sin perder históricos.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

type CycleSnapshot = {
  id: string;
  name: string;
  state: string;
  cadenceSource: string;
  archivedAt: string | null;
};

type Scenario = {
  id: string;
  cycleUpcomingCount: number;
  manualId: string;
  cadenceIds: string[];
};

async function createTeam(key: string, cycleUpcomingCount: number) {
  const result = await gql(
    app,
    `mutation($key: String!, $count: Int!) {
      teamCreate(input: {
        name: $key, key: $key, cyclesEnabled: true, cycleUpcomingCount: $count
      }) {
        team { id cyclesEnabled cycleUpcomingCount cycles { id state cadenceSource archivedAt } }
      }
    }`,
    { key, count: cycleUpcomingCount },
  );
  expect(result.errors).toBeUndefined();
  expect(result.data!.teamCreate.team).toMatchObject({
    cyclesEnabled: true,
    cycleUpcomingCount,
  });
  return result.data!.teamCreate.team as {
    id: string;
    cycles: CycleSnapshot[];
  };
}

async function createManualCycle(teamId: string, name: string): Promise<CycleSnapshot> {
  const result = await gql(
    app,
    `mutation($teamId: ID!, $name: String!) {
      cycleCreate(input: {
        teamId: $teamId, name: $name,
        startsAt: "2045-01-01T00:00:00.000Z", endsAt: "2045-01-14T23:59:59.000Z"
      }) { cycle { id name state cadenceSource archivedAt } }
    }`,
    { teamId, name },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreate.cycle as CycleSnapshot;
}

async function createCadenceCycle(teamId: string, name: string): Promise<CycleSnapshot> {
  const result = await gql(
    app,
    `mutation($teamId: ID!, $name: String!) {
      cycleCreateFromCadence(input: { teamId: $teamId, name: $name }) {
        cycle { id name state cadenceSource archivedAt }
      }
    }`,
    { teamId, name },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreateFromCadence.cycle as CycleSnapshot;
}

async function createCycle(
  teamId: string,
  name: string,
  state: "ACTIVE" | "COMPLETED",
): Promise<CycleSnapshot> {
  const result = await gql(
    app,
    `mutation($teamId: ID!, $name: String!, $state: CycleState!) {
      cycleCreate(input: {
        teamId: $teamId, name: $name, state: $state,
        startsAt: "2035-01-01T00:00:00.000Z", endsAt: "2035-01-14T23:59:59.000Z"
      }) { cycle { id name state cadenceSource archivedAt } }
    }`,
    { teamId, name, state },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreate.cycle as CycleSnapshot;
}

async function listCycles(teamId: string, includeArchived = false): Promise<CycleSnapshot[]> {
  const result = await gql(
    app,
    `query($teamId: ID!, $includeArchived: Boolean!) {
      cycles(teamId: $teamId, includeArchived: $includeArchived) {
        id name state cadenceSource archivedAt
      }
    }`,
    { teamId, includeArchived },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycles as CycleSnapshot[];
}

describe("cycles disabled", () => {
  it("archives manual, cadence, and mixed futures while preserving history", async () => {
    const manualTeam = await createTeam("M627", 0);
    const cadenceTeam = await createTeam("C627", 2);
    const mixedTeam = await createTeam("X627", 2);

    const manual = await createManualCycle(manualTeam.id, "Manual only");
    await createCadenceCycle(cadenceTeam.id, "Cadence only");
    const cadence = await listCycles(cadenceTeam.id);
    await createCadenceCycle(mixedTeam.id, "Mixed cadence");
    const mixedManual = await createManualCycle(mixedTeam.id, "Mixed manual");
    const mixedCadence = (await listCycles(mixedTeam.id)).filter(
      (cycle) => cycle.cadenceSource === "CADENCE",
    );
    const active = await createCycle(mixedTeam.id, "Historical active", "ACTIVE");
    const completed = await createCycle(mixedTeam.id, "Historical completed", "COMPLETED");

    expect(manualTeam.cycles).toEqual([]);
    expect(manual.cadenceSource).toBe("MANUAL");
    expect(cadence).toHaveLength(2);
    expect(cadence.every((cycle) => cycle.cadenceSource === "CADENCE")).toBe(true);
    expect(mixedCadence).toHaveLength(2);

    const scenarios: Scenario[] = [
      {
        id: manualTeam.id,
        cycleUpcomingCount: 0,
        manualId: manual.id,
        cadenceIds: [],
      },
      {
        id: cadenceTeam.id,
        cycleUpcomingCount: 2,
        manualId: "",
        cadenceIds: cadence.map((cycle) => cycle.id),
      },
      {
        id: mixedTeam.id,
        cycleUpcomingCount: 2,
        manualId: mixedManual.id,
        cadenceIds: mixedCadence.map((cycle) => cycle.id),
      },
    ];

    const beforeDisable = new Map<string, CycleSnapshot[]>();
    for (const scenario of scenarios) {
      beforeDisable.set(scenario.id, await listCycles(scenario.id, true));
      const updated = await gql(
        app,
        `mutation($id: ID!) {
          teamUpdate(id: $id, input: { cyclesEnabled: false }) {
            team { cyclesEnabled cycleUpcomingCount }
          }
        }`,
        { id: scenario.id },
      );
      expect(updated.errors).toBeUndefined();
      expect(updated.data!.teamUpdate.team).toMatchObject({
        cyclesEnabled: false,
        cycleUpcomingCount: scenario.cycleUpcomingCount,
      });

      const activeCycles = await listCycles(scenario.id);
      expect(activeCycles.some((cycle) => cycle.state === "UPCOMING")).toBe(false);
      const allCycles = await listCycles(scenario.id, true);
      expect(
        allCycles.filter((cycle) => cycle.state === "UPCOMING" && cycle.archivedAt === null),
      ).toEqual([]);
      const previousUpcoming = beforeDisable
        .get(scenario.id)!
        .filter((cycle) => cycle.state === "UPCOMING");
      const archivedUpcoming = allCycles.filter(
        (cycle) => cycle.state === "UPCOMING" && cycle.archivedAt !== null,
      );
      expect(archivedUpcoming).toHaveLength(previousUpcoming.length);
      for (const source of ["MANUAL", "CADENCE"] as const) {
        expect(archivedUpcoming.filter((cycle) => cycle.cadenceSource === source)).toHaveLength(
          previousUpcoming.filter((cycle) => cycle.cadenceSource === source).length,
        );
      }
      for (const id of [
        ...scenario.cadenceIds,
        ...(scenario.manualId ? [scenario.manualId] : []),
      ]) {
        expect(archivedUpcoming.find((cycle) => cycle.id === id)).toMatchObject({
          id,
          archivedAt: expect.any(String),
        });
      }
    }

    const mixedAfterDisable = await listCycles(mixedTeam.id, true);
    expect(mixedAfterDisable.find((cycle) => cycle.id === active.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });
    expect(mixedAfterDisable.find((cycle) => cycle.id === completed.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });

    const disabledUpdates = [
      `{ name: "Must stay unchanged" }`,
      `{ startsAt: "2046-01-01T00:00:00.000Z" }`,
      `{ endsAt: "2046-01-14T23:59:59.000Z" }`,
      `{ state: COMPLETED }`,
      `{ archived: true }`,
      `{ cadenceSource: MANUAL }`,
    ];
    for (const input of disabledUpdates) {
      const rejectedUpdate = await gql(
        app,
        `mutation($id: ID!) { cycleUpdate(id: $id, input: ${input}) { success } }`,
        { id: active.id },
      );
      expect(rejectedUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      expect(rejectedUpdate.errors?.[0]?.message).toBe("Cycles are disabled for this Team");
    }
    expect(
      (await listCycles(mixedTeam.id, true)).find((cycle) => cycle.id === active.id),
    ).toMatchObject({
      name: "Historical active",
    });

    const reactivated = await gql(
      app,
      `mutation($id: ID!) {
        teamUpdate(id: $id, input: { cyclesEnabled: true }) {
          team { cyclesEnabled cycleUpcomingCount }
        }
      }`,
      { id: mixedTeam.id },
    );
    expect(reactivated.errors).toBeUndefined();
    expect(reactivated.data!.teamUpdate.team).toMatchObject({
      cyclesEnabled: true,
      cycleUpcomingCount: 2,
    });
    const mixedAfterReactivate = await listCycles(mixedTeam.id, true);
    const visibleUpcoming = mixedAfterReactivate.filter(
      (cycle) => cycle.state === "UPCOMING" && cycle.archivedAt === null,
    );
    expect(visibleUpcoming).toHaveLength(2);
    expect(visibleUpcoming.every((cycle) => cycle.cadenceSource === "CADENCE")).toBe(true);
    expect(mixedAfterReactivate.find((cycle) => cycle.id === mixedManual.id)).toMatchObject({
      archivedAt: expect.any(String),
      name: "Mixed manual",
    });
    expect(mixedAfterReactivate.find((cycle) => cycle.id === active.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });
    expect(mixedAfterReactivate.find((cycle) => cycle.id === completed.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });

    for (const scenario of scenarios) {
      const previous = beforeDisable.get(scenario.id)!;
      const after = await listCycles(scenario.id, true);
      for (const oldCycle of previous) {
        expect(after.find((cycle) => cycle.id === oldCycle.id)).toMatchObject({
          id: oldCycle.id,
          name: oldCycle.name,
          state: oldCycle.state === "ACTIVE" ? "COMPLETED" : oldCycle.state,
          archivedAt: oldCycle.state === "UPCOMING" ? expect.any(String) : null,
        });
      }
    }
  });
});
