import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { newId, now } from "../db/util.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import {
  ensureUpcomingPostgresCadenceCyclesInTransaction,
  updatePostgresCycle,
} from "./postgres-cycles.ts";
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

  integration("serializes concurrent cycle updates without a PostgreSQL deadlock", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb622_concurrency",
      lockKey: `prb622-concurrency-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const pool = new Bun.SQL({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      max: 4,
      connectionTimeout: 5,
    });
    const [firstConnection, secondConnection, blockerConnection] = await Promise.all([
      pool.reserve(),
      pool.reserve(),
      pool.reserve(),
    ]);
    const connections = [firstConnection, secondConnection, blockerConnection];
    const firstPersistence = createPostgresPersistence(firstConnection as unknown as Bun.SQL, {
      close: false,
    });
    const secondPersistence = createPostgresPersistence(secondConnection as unknown as Bun.SQL, {
      close: false,
    });
    let releaseBlocker!: () => void;
    let blockerPromise: Promise<unknown> | undefined;
    let updates: Promise<readonly unknown[]> | undefined;
    try {
      for (const connection of connections) {
        await connection`SET search_path TO ${connection(harness.schema)}, public`;
      }
      await firstConnection`SET deadlock_timeout = '100ms'`;
      await secondConnection`SET deadlock_timeout = '100ms'`;

      const seeded = await bootstrapPostgres(persistence);
      expect(seeded.created).toBe(true);
      const team = await persistence.one<TeamRow>("SELECT * FROM teams LIMIT 1");
      const viewer = await persistence.one<ActorRow>("SELECT * FROM actors WHERE name = 'admin'");
      if (!team || !viewer) throw new Error("PostgreSQL concurrency fixture is incomplete");
      await persistence.execute(
        `UPDATE teams
         SET cycles_enabled = TRUE, cycle_duration_weeks = 1, cycle_start_day = 4,
             cycle_cooldown_days = 0, cycle_upcoming_count = 3
         WHERE id = $1`,
        [team.id],
      );
      const timestamp = now();
      const cycles = [
        [newId(), 1, "2030-01-03T00:00:00.000Z", "2030-01-09T00:00:00.000Z"],
        [newId(), 2, "2030-01-10T00:00:00.000Z", "2030-01-16T00:00:00.000Z"],
        [newId(), 3, "2030-01-17T00:00:00.000Z", "2030-01-23T00:00:00.000Z"],
      ] as const;
      for (const [id, number, startsAt, endsAt] of cycles) {
        await persistence.execute(
          `INSERT INTO cycles
           (id, team_id, number, name, starts_at, ends_at, state, cadence_source, created_at, updated_at, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'upcoming', 'cadence', $7, $7, NULL)`,
          [id, team.id, number, `Concurrent cycle ${number}`, startsAt, endsAt, timestamp],
        );
      }

      let teamLockAcquired!: () => void;
      const teamLockReady = new Promise<void>((resolve) => {
        teamLockAcquired = resolve;
      });
      const blockerReleased = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      blockerPromise = blockerConnection.begin(async (tx) => {
        await tx`SELECT id FROM teams WHERE id = ${team.id} FOR UPDATE`;
        teamLockAcquired();
        await blockerReleased;
      });
      await teamLockReady;

      updates = Promise.all([
        updatePostgresCycle(firstPersistence, viewer, cycles[0]![0], {
          startsAt: "2031-01-01T00:00:00.000Z",
          endsAt: "2031-01-07T00:00:00.000Z",
        }),
        updatePostgresCycle(secondPersistence, viewer, cycles[1]![0], {
          startsAt: "2031-02-01T00:00:00.000Z",
          endsAt: "2031-02-07T00:00:00.000Z",
        }),
      ]);

      let waitingForTeam = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await persistence.one<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query LIKE '%FROM teams WHERE id = $1 FOR UPDATE%'`,
        );
        waitingForTeam = Number(activity?.count ?? 0);
        if (waitingForTeam >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingForTeam).toBeGreaterThanOrEqual(2);
      releaseBlocker();
      await blockerPromise;
      const results = await updates;
      expect(results).toHaveLength(2);

      const persisted = await persistence.many<{
        id: string;
        cadence_source: string;
        starts_at: string;
        ends_at: string;
      }>("SELECT id, cadence_source, starts_at, ends_at FROM cycles WHERE team_id = $1", [team.id]);
      expect(persisted.find((cycle) => cycle.id === cycles[0]![0])).toMatchObject({
        cadence_source: "manual",
        starts_at: "2031-01-01T00:00:00.000Z",
        ends_at: "2031-01-07T00:00:00.000Z",
      });
      expect(persisted.find((cycle) => cycle.id === cycles[1]![0])).toMatchObject({
        cadence_source: "manual",
        starts_at: "2031-02-01T00:00:00.000Z",
        ends_at: "2031-02-07T00:00:00.000Z",
      });
    } finally {
      releaseBlocker?.();
      await blockerPromise?.catch(() => undefined);
      await updates?.catch(() => undefined);
      await firstPersistence.close();
      await secondPersistence.close();
      for (const connection of connections) connection.release();
      await pool.close({ timeout: 5 });
      await persistence.close();
      await harness.close();
    }
  });
});
