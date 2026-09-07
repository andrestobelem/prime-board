import { describe, expect, it } from "bun:test";
import type {
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { TeamRow } from "./teams.ts";
import {
  ensureUpcomingPostgresCadenceCyclesInTransaction,
  type PostgresCycleRow,
} from "./postgres-cycles.ts";

function planningTeam(): TeamRow {
  return {
    id: "team-prb-622",
    workspace_id: null,
    name: "PRB-622",
    key: "R622",
    description: null,
    next_issue_number: 1,
    default_state_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    visibility: "public",
    access_policy: "team_members",
    timezone: "UTC",
    estimates_enabled: false,
    estimate_scale: "fibonacci",
    estimate_extended_scale: false,
    estimate_allow_zero: false,
    cycles_enabled: true,
    cycle_duration_weeks: 1,
    cycle_start_day: 4,
    cycle_cooldown_days: 0,
    cycle_upcoming_count: 3,
    cycle_rollover_enabled: false,
    cycle_auto_add_enabled: false,
  };
}

function cycle(
  id: string,
  number: number,
  state: PostgresCycleRow["state"],
  startsAt: string,
  endsAt: string,
  cadenceSource: PostgresCycleRow["cadence_source"],
): PostgresCycleRow {
  return {
    id,
    team_id: "team-prb-622",
    number,
    name: `Cycle ${number}`,
    starts_at: startsAt,
    ends_at: endsAt,
    state,
    cadence_source: cadenceSource,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
  };
}

function transactionFor(cycles: PostgresCycleRow[]): PersistenceTransaction {
  return {
    async one<Row extends object>(): Promise<Row | null> {
      return null;
    },
    async many<Row extends object>(sql: string): Promise<readonly Row[]> {
      const rows = sql.includes("state = 'upcoming'")
        ? cycles.filter((row) => row.state === "upcoming" && row.archived_at === null)
        : cycles.filter((row) => row.archived_at === null);
      return rows as unknown as readonly Row[];
    },
    async execute<Row extends object>(
      sql: string,
      params?: SqlParameters,
    ): Promise<PersistenceResult<Row>> {
      if (sql.includes("UPDATE cycles SET starts_at")) {
        const [startsAt, endsAt, , id] = params ?? [];
        const row = cycles.find((candidate) => candidate.id === id);
        if (!row) throw new Error(`Unknown cycle ${String(id)}`);
        row.starts_at = String(startsAt);
        row.ends_at = String(endsAt);
      }
      if (sql.includes("UPDATE cycles SET archived_at")) {
        const id = params?.[1];
        const row = cycles.find((candidate) => candidate.id === id);
        if (!row) throw new Error(`Unknown cycle ${String(id)}`);
        row.archived_at = String(params?.[0]);
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

describe("PostgreSQL cycles", () => {
  it("refluye CADENCE por número alrededor de un MANUAL", async () => {
    const scenarios = [
      { name: "before", startsAt: "2029-12-10T00:00:00.000Z", endsAt: "2029-12-16T00:00:00.000Z" },
      { name: "between", startsAt: "2030-01-10T00:00:00.000Z", endsAt: "2030-01-16T00:00:00.000Z" },
      { name: "after", startsAt: "2030-02-01T00:00:00.000Z", endsAt: "2030-02-07T00:00:00.000Z" },
    ];

    for (const scenario of scenarios) {
      const rows = [
        cycle(
          `${scenario.name}-anchor`,
          0,
          "completed",
          "2029-12-26T00:00:00.000Z",
          "2030-01-01T00:00:00.000Z",
          "manual",
        ),
        cycle(
          `${scenario.name}-first`,
          1,
          "upcoming",
          "2030-01-03T00:00:00.000Z",
          "2030-01-09T00:00:00.000Z",
          "cadence",
        ),
        cycle(
          `${scenario.name}-manual`,
          2,
          "upcoming",
          scenario.startsAt,
          scenario.endsAt,
          "manual",
        ),
        cycle(
          `${scenario.name}-last`,
          3,
          "upcoming",
          "2030-01-10T00:00:00.000Z",
          "2030-01-16T00:00:00.000Z",
          "cadence",
        ),
      ];
      const manual = rows[2]!;
      const manualDates = { startsAt: manual.starts_at, endsAt: manual.ends_at };
      const result = await ensureUpcomingPostgresCadenceCyclesInTransaction(
        transactionFor(rows),
        planningTeam(),
      );

      expect(result).toHaveLength(3);
      expect(rows.filter((row) => row.state === "upcoming")).toHaveLength(3);
      expect(rows.map((row) => row.id)).toEqual([
        `${scenario.name}-anchor`,
        `${scenario.name}-first`,
        `${scenario.name}-manual`,
        `${scenario.name}-last`,
      ]);
      expect(manual).toMatchObject({
        id: `${scenario.name}-manual`,
        number: 2,
        starts_at: manualDates.startsAt,
        ends_at: manualDates.endsAt,
        cadence_source: "manual",
      });

      const upcoming = rows.filter((row) => row.state === "upcoming");
      const ordered = [...upcoming].sort(
        (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.number - b.number,
      );
      for (let index = 1; index < ordered.length; index += 1) {
        expect(Date.parse(ordered[index - 1]!.ends_at)).toBeLessThanOrEqual(
          Date.parse(ordered[index]!.starts_at),
        );
      }
      const first = rows[1]!;
      const last = rows[3]!;
      if (scenario.name === "before") {
        expect(Date.parse(manual.ends_at)).toBeLessThanOrEqual(Date.parse(first.starts_at));
      } else {
        expect(Date.parse(first.ends_at)).toBeLessThanOrEqual(Date.parse(manual.starts_at));
        expect(Date.parse(manual.ends_at)).toBeLessThanOrEqual(Date.parse(last.starts_at));
      }
    }
  });
});
