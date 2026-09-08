// PRB-628: el horizonte inicial de Cycles debe ser igual en ambos backends.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

type GraphqlResponse = {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

function localDate(iso: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  const { year, month, day } = values;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("PostgreSQL cycle response has no complete local date");
  }
  return Date.UTC(year, month - 1, day);
}

function localPart(iso: string, timezone: string, type: Intl.DateTimeFormatPartTypes): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .find((part) => part.type === type)?.value ?? ""
  );
}

describe("PostgreSQL teamCreate y horizonte de Cycles", () => {
  integration("crea el horizonte configurado y respeta disabled, cero y el límite", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb628_team_create",
      lockKey: `prb628-team-create-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const db = openDatabase(":memory:");
    let stop: (() => void) | undefined;
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
      const config: Config = {
        port: 0,
        host: "127.0.0.1",
        authMode: "api-key",
        dbPath: ":memory:",
        postgresUrl: process.env.PRIME_BOARD_POSTGRES_URL,
        persistenceBackend: "postgres",
        dev: false,
        webDist: "/tmp/prime-board-no-web",
        repoRoot: null,
        bootstrap: resolveBootstrapIdentity({}),
      };
      const app = createApp({ db, config, persistence });
      stop = () => app.server.stop(true);

      const request = async (query: string): Promise<GraphqlResponse> => {
        const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${seeded.adminApiKey}`,
          },
          body: JSON.stringify({ query }),
        });
        return (await response.json()) as GraphqlResponse;
      };

      const configured = await request(`mutation {
        teamCreate(input: {
          name: "PRB-628 PostgreSQL horizon", key: "PGH",
          cyclesEnabled: true, timezone: "America/New_York",
          cycleStartDay: WEDNESDAY, cycleDurationWeeks: 1,
          cycleCooldownDays: 2, cycleUpcomingCount: 5
        }) { team { id cycleUpcomingCount } }
      }`);
      expect(configured.errors).toBeUndefined();
      const configuredTeam = configured.data?.teamCreate as {
        team: { id: string; cycleUpcomingCount: number };
      };
      expect(configuredTeam.team.cycleUpcomingCount).toBe(5);

      const cyclesResult = await request(`query {
        cycles(teamId: "${configuredTeam.team.id}") {
          number state cadenceSource startsAt endsAt
        }
      }`);
      expect(cyclesResult.errors).toBeUndefined();
      const cycles = (cyclesResult.data?.cycles ?? []) as Array<{
        number: number;
        state: string;
        cadenceSource: string;
        startsAt: string;
        endsAt: string;
      }>;
      expect(cycles).toHaveLength(5);
      expect(cycles.map((cycle) => cycle.number)).toEqual([1, 2, 3, 4, 5]);
      expect(cycles.every((cycle) => cycle.state === "UPCOMING")).toBe(true);
      expect(cycles.every((cycle) => cycle.cadenceSource === "CADENCE")).toBe(true);
      expect(localPart(cycles[0]!.startsAt, "America/New_York", "weekday")).toBe("Wednesday");
      expect(localPart(cycles[0]!.startsAt, "America/New_York", "hour")).toBe("00");
      expect(localPart(cycles[0]!.startsAt, "America/New_York", "minute")).toBe("00");
      expect(localPart(cycles[0]!.endsAt, "America/New_York", "weekday")).toBe("Tuesday");
      expect(
        localDate(cycles[0]!.endsAt, "America/New_York") -
          localDate(cycles[0]!.startsAt, "America/New_York"),
      ).toBe(6 * 24 * 60 * 60 * 1000);
      expect(
        localDate(cycles[1]!.startsAt, "America/New_York") -
          localDate(cycles[0]!.startsAt, "America/New_York"),
      ).toBe(14 * 24 * 60 * 60 * 1000);

      const disabled = await request(`mutation {
        teamCreate(input: {
          name: "PRB-628 disabled", key: "PGD", cyclesEnabled: false
        }) { team { id } }
      }`);
      expect(disabled.errors).toBeUndefined();
      const disabledTeam = disabled.data?.teamCreate as { team: { id: string } };
      const disabledCycles = await request(
        `query { cycles(teamId: "${disabledTeam.team.id}") { id } }`,
      );
      expect(disabledCycles.errors).toBeUndefined();
      expect(disabledCycles.data?.cycles).toEqual([]);

      const zero = await request(`mutation {
        teamCreate(input: {
          name: "PRB-628 zero", key: "PGZ", cyclesEnabled: true, cycleUpcomingCount: 0
        }) { team { id } }
      }`);
      expect(zero.errors).toBeUndefined();
      const zeroTeam = zero.data?.teamCreate as { team: { id: string } };
      const zeroCycles = await request(`query { cycles(teamId: "${zeroTeam.team.id}") { id } }`);
      expect(zeroCycles.errors).toBeUndefined();
      expect(zeroCycles.data?.cycles).toEqual([]);

      const overLimit = await request(`mutation {
        teamCreate(input: {
          name: "PRB-628 over limit", key: "PGL", cycleUpcomingCount: 16
        }) { success }
      }`);
      expect(overLimit.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      expect(await persistence.one("SELECT id FROM teams WHERE key = $1", ["PGL"])).toBeNull();
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });

  integration("revierte Team, workflow y horizonte si falla la inserción", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb628_team_rollback",
      lockKey: `prb628-team-rollback-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const db = openDatabase(":memory:");
    let stop: (() => void) | undefined;
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
      await persistence.execute(`
        CREATE FUNCTION prb628_fail_cycle_horizon() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'PRB-628 cycle horizon failure';
        END;
        $$
      `);
      await persistence.execute(`
        CREATE TRIGGER prb628_fail_cycle_horizon
        BEFORE INSERT ON cycles FOR EACH ROW
        EXECUTE FUNCTION prb628_fail_cycle_horizon()
      `);
      const config: Config = {
        port: 0,
        host: "127.0.0.1",
        authMode: "api-key",
        dbPath: ":memory:",
        postgresUrl: process.env.PRIME_BOARD_POSTGRES_URL,
        persistenceBackend: "postgres",
        dev: false,
        webDist: "/tmp/prime-board-no-web",
        repoRoot: null,
        bootstrap: resolveBootstrapIdentity({}),
      };
      const app = createApp({ db, config, persistence });
      stop = () => app.server.stop(true);
      const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${seeded.adminApiKey}`,
        },
        body: JSON.stringify({
          query: `mutation {
            teamCreate(input: { name: "PRB-628 rollback", key: "PGR" }) { success }
          }`,
        }),
      });
      const failed = (await response.json()) as GraphqlResponse;
      expect(failed.errors).toBeDefined();
      expect(await persistence.one("SELECT id FROM teams WHERE key = $1", ["PGR"])).toBeNull();
      expect(
        await persistence.one<{ count: number }>(
          "SELECT count(*)::int AS count FROM workflow_states WHERE team_id IN (SELECT id FROM teams WHERE key = $1)",
          ["PGR"],
        ),
      ).toEqual({ count: 0 });
      expect(
        await persistence.one<{ count: number }>(
          "SELECT count(*)::int AS count FROM cycles WHERE team_id IN (SELECT id FROM teams WHERE key = $1)",
          ["PGR"],
        ),
      ).toEqual({ count: 0 });
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
