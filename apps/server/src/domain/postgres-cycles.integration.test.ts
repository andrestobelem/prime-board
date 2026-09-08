import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { newId, now } from "../db/util.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { ensureUpcomingPostgresCadenceCyclesInTransaction } from "./postgres-cycles.ts";
import type { TeamRow } from "./teams.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

const scenarios = [
  { name: "before", startsAt: "2029-12-10T00:00:00.000Z", endsAt: "2029-12-16T00:00:00.000Z" },
  { name: "between", startsAt: "2030-01-10T00:00:00.000Z", endsAt: "2030-01-16T00:00:00.000Z" },
  { name: "after", startsAt: "2030-02-01T00:00:00.000Z", endsAt: "2030-02-07T00:00:00.000Z" },
] as const;

describe("PostgreSQL cycles integration", () => {
  integration("reflows and replenishes cadence around a manual cycle", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb622_cycles",
      lockKey: `prb622-cycles-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    try {
      const seeded = await bootstrapPostgres(persistence);
      expect(seeded.created).toBe(true);
      const team = await persistence.one<TeamRow>("SELECT * FROM teams LIMIT 1");
      if (!team) throw new Error("PostgreSQL cycles fixture has no Team");
      await persistence.execute(
        `UPDATE teams
         SET cycles_enabled = TRUE, cycle_duration_weeks = 1, cycle_start_day = 4,
             cycle_cooldown_days = 0, cycle_upcoming_count = 3
         WHERE id = $1`,
        [team.id],
      );

      for (const scenario of scenarios) {
        await persistence.execute("DELETE FROM cycles WHERE team_id = $1", [team.id]);
        const timestamp = now();
        const rows = [
          {
            id: newId(),
            number: 1,
            state: "completed",
            startsAt: "2029-12-26T00:00:00.000Z",
            endsAt: "2030-01-01T00:00:00.000Z",
            cadenceSource: "manual",
          },
          {
            id: newId(),
            number: 2,
            state: "upcoming",
            startsAt: "2030-01-03T00:00:00.000Z",
            endsAt: "2030-01-09T00:00:00.000Z",
            cadenceSource: "cadence",
          },
          {
            id: newId(),
            number: 3,
            state: "upcoming",
            startsAt: scenario.startsAt,
            endsAt: scenario.endsAt,
            cadenceSource: "manual",
          },
          {
            id: newId(),
            number: 4,
            state: "upcoming",
            startsAt: "2030-01-10T00:00:00.000Z",
            endsAt: "2030-01-16T00:00:00.000Z",
            cadenceSource: "cadence",
          },
        ] as const;
        for (const row of rows) {
          await persistence.execute(
            `INSERT INTO cycles
             (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, NULL)`,
            [
              row.id,
              team.id,
              row.number,
              `${scenario.name} cycle ${row.number}`,
              row.startsAt,
              row.endsAt,
              row.state,
              row.cadenceSource,
              timestamp,
            ],
          );
        }
        await persistence.execute("DELETE FROM cycles WHERE id = $1", [
          scenario.name === "after" ? rows[3]!.id : rows[1]!.id,
        ]);

        const result = await persistence.transaction(async (tx) => {
          const lockedTeam = await tx.one<TeamRow>("SELECT * FROM teams WHERE id = $1 FOR UPDATE", [
            team.id,
          ]);
          if (!lockedTeam) throw new Error("PostgreSQL cycles fixture Team disappeared");
          return ensureUpcomingPostgresCadenceCyclesInTransaction(tx, lockedTeam);
        });

        expect(result).toHaveLength(3);
        const manual = result.find((cycle) => cycle.cadence_source === "manual");
        expect(manual).toMatchObject({
          number: 3,
          starts_at: scenario.startsAt,
          ends_at: scenario.endsAt,
          cadence_source: "manual",
        });
        expect(result.filter((cycle) => cycle.cadence_source === "cadence")).toHaveLength(2);
        const ordered = [...result].sort(
          (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.number - b.number,
        );
        for (let index = 1; index < ordered.length; index += 1) {
          expect(Date.parse(ordered[index - 1]!.ends_at)).toBeLessThanOrEqual(
            Date.parse(ordered[index]!.starts_at),
          );
        }
      }
    } finally {
      await persistence.close();
      await harness.close();
    }
  });
});
