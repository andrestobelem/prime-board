// PRB-627: verifica en PostgreSQL el retiro completo de futuros de Cycles.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openDatabase } from "../db/database.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createPostgresHarness, type PostgresHarness } from "../db/postgres/test-harness.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

type CycleSnapshot = {
  id: string;
  name: string;
  number: number;
  state: string;
  cadenceSource: string;
  archivedAt: string | null;
};

type GraphQLResponse = {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

let harness: PostgresHarness | undefined;
let persistence: ReturnType<typeof createPostgresPersistence> | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
let stop: (() => void) | undefined;
let request: (query: string, variables?: Record<string, unknown>) => Promise<GraphQLResponse>;

beforeAll(async () => {
  const url = process.env.PRIME_BOARD_POSTGRES_URL;
  if (!url) return;

  harness = await createPostgresHarness({ url, schemaPrefix: "prb627_cycles" });
  persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, { close: false });
  db = openDatabase(":memory:");
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    authMode: "api-key",
    dbPath: ":memory:",
    postgresUrl: url,
    persistenceBackend: "postgres",
    dev: false,
    webDist: "/tmp/prime-board-no-web",
    repoRoot: null,
    bootstrap: resolveBootstrapIdentity({}),
  };
  const bootstrapped = await bootstrapPostgres(persistence, config.bootstrap);
  if (!bootstrapped.adminApiKey) throw new Error("PostgreSQL fixture did not return an admin key");
  const app = createApp({ db, config, persistence });
  stop = () => app.server.stop();
  request = async (query, variables = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bootstrapped.adminApiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as GraphQLResponse;
  };
});

afterAll(async () => {
  stop?.();
  db?.close();
  await persistence?.close();
  await harness?.close();
});

async function createTeam(key: string, cycleUpcomingCount: number) {
  const result = await request(
    `mutation($key: String!, $count: Int!) {
      teamCreate(input: {
        name: $key, key: $key, cyclesEnabled: true, cycleUpcomingCount: $count
      }) {
        team { id cyclesEnabled cycleUpcomingCount cycles { id number state cadenceSource archivedAt } }
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
  const result = await request(
    `mutation($teamId: ID!, $name: String!) {
      cycleCreate(input: {
        teamId: $teamId, name: $name,
        startsAt: "2045-01-01T00:00:00.000Z", endsAt: "2045-01-14T23:59:59.000Z"
      }) { cycle { id name number state cadenceSource archivedAt } }
    }`,
    { teamId, name },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreate.cycle as CycleSnapshot;
}

async function createCadenceCycle(teamId: string, name: string): Promise<CycleSnapshot> {
  const result = await request(
    `mutation($teamId: ID!, $name: String!) {
      cycleCreateFromCadence(input: { teamId: $teamId, name: $name }) {
        cycle { id name number state cadenceSource archivedAt }
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
  const result = await request(
    `mutation($teamId: ID!, $name: String!, $state: CycleState!) {
      cycleCreate(input: {
        teamId: $teamId, name: $name, state: $state,
        startsAt: "2035-01-01T00:00:00.000Z", endsAt: "2035-01-14T23:59:59.000Z"
      }) { cycle { id name number state cadenceSource archivedAt } }
    }`,
    { teamId, name, state },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycleCreate.cycle as CycleSnapshot;
}

async function listCycles(teamId: string, includeArchived = false): Promise<CycleSnapshot[]> {
  const result = await request(
    `query($teamId: ID!, $includeArchived: Boolean!) {
      cycles(teamId: $teamId, includeArchived: $includeArchived) {
        id name number state cadenceSource archivedAt
      }
    }`,
    { teamId, includeArchived },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.cycles as CycleSnapshot[];
}

describe("PostgreSQL cycles disabled", () => {
  integration("archives a new CADENCE cycle when MANUAL fills the horizon", async () => {
    const team = await createTeam("G625M", 2);
    const manualOne = await createManualCycle(team.id, "Manual one");
    const manualTwo = await createManualCycle(team.id, "Manual two");
    const before = await listCycles(team.id);
    expect(before).toHaveLength(4);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: manualOne.id, cadenceSource: "MANUAL", archivedAt: null }),
        expect.objectContaining({ id: manualTwo.id, cadenceSource: "MANUAL", archivedAt: null }),
      ]),
    );

    const generated = await createCadenceCycle(team.id, "Archived cadence");
    expect(generated).toMatchObject({
      id: expect.any(String),
      state: "UPCOMING",
      cadenceSource: "CADENCE",
      archivedAt: expect.any(String),
    });

    const after = await listCycles(team.id);
    expect(after).toHaveLength(2);
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: manualOne.id, cadenceSource: "MANUAL", archivedAt: null }),
        expect.objectContaining({ id: manualTwo.id, cadenceSource: "MANUAL", archivedAt: null }),
      ]),
    );
    expect(after.map((cycle) => cycle.cadenceSource)).toEqual(["MANUAL", "MANUAL"]);
  });

  integration("preserves a newly created cadence cycle in a full horizon", async () => {
    const team = await createTeam("G625H", 2);
    expect(team.cycles).toHaveLength(2);

    const created = await createCadenceCycle(team.id, "New cadence cycle");
    expect(created).toMatchObject({
      id: expect.any(String),
      number: 3,
      name: "New cadence cycle",
      state: "UPCOMING",
      cadenceSource: "CADENCE",
      archivedAt: null,
    });

    const visible = await listCycles(team.id);
    expect(visible).toHaveLength(2);
    expect(visible).toContainEqual({
      id: created.id,
      name: "New cadence cycle",
      number: 3,
      state: "UPCOMING",
      cadenceSource: "CADENCE",
      archivedAt: null,
    });
  });

  integration("allows cadence cycle creation through PostgreSQL dispatch", async () => {
    const team = await createTeam("G627P", 2);
    const cycle = await createCadenceCycle(team.id, "Cadence dispatch");

    expect(cycle).toMatchObject({
      state: "UPCOMING",
      cadenceSource: "CADENCE",
      archivedAt: null,
    });
  });

  integration("archives all future sources and does not restore retired cycles", async () => {
    const manualTeam = await createTeam("M627P", 0);
    const cadenceTeam = await createTeam("C627P", 2);
    const mixedTeam = await createTeam("X627P", 2);

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

    const scenarios = [
      {
        id: manualTeam.id,
        count: 0,
        future: [manual.id],
      },
      {
        id: cadenceTeam.id,
        count: 2,
        future: cadence.map((cycle) => cycle.id),
      },
      {
        id: mixedTeam.id,
        count: 2,
        future: [mixedManual.id, ...mixedCadence.map((cycle) => cycle.id)],
      },
    ];
    const beforeDisable = new Map<string, CycleSnapshot[]>();
    for (const scenario of scenarios) {
      beforeDisable.set(scenario.id, await listCycles(scenario.id, true));
      const updated = await request(
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
        cycleUpcomingCount: scenario.count,
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
      for (const id of scenario.future) {
        expect(archivedUpcoming.find((cycle) => cycle.id === id)).toMatchObject({
          id,
          archivedAt: expect.any(String),
        });
      }
    }

    const disabledUpdates = [
      `{ name: "Must stay unchanged" }`,
      `{ startsAt: "2046-01-01T00:00:00.000Z" }`,
      `{ endsAt: "2046-01-14T23:59:59.000Z" }`,
      `{ state: COMPLETED }`,
      `{ archived: true }`,
      `{ cadenceSource: MANUAL }`,
    ];
    for (const input of disabledUpdates) {
      const rejectedUpdate = await request(
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

    const beforeReactivate = await listCycles(mixedTeam.id, true);
    const reactivated = await request(
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
    const afterReactivate = await listCycles(mixedTeam.id, true);
    expect(
      afterReactivate.filter((cycle) => cycle.state === "UPCOMING" && cycle.archivedAt === null),
    ).toHaveLength(2);
    for (const oldCycle of beforeReactivate) {
      expect(afterReactivate.find((cycle) => cycle.id === oldCycle.id)).toMatchObject({
        id: oldCycle.id,
        name: oldCycle.name,
        state: oldCycle.state,
        archivedAt: oldCycle.archivedAt,
      });
    }
    expect(afterReactivate.find((cycle) => cycle.id === mixedManual.id)).toMatchObject({
      archivedAt: expect.any(String),
      name: "Mixed manual",
    });
    expect(afterReactivate.find((cycle) => cycle.id === active.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });
    expect(afterReactivate.find((cycle) => cycle.id === completed.id)).toMatchObject({
      state: "COMPLETED",
      archivedAt: null,
    });
  });
});
