import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createPostgresIssue, getPostgresIssue } from "./postgres-issues.ts";
import {
  advancePostgresCycle,
  createPostgresCycle,
  deletePostgresCycle,
  listPostgresCycles,
  updatePostgresCycle,
} from "./postgres-cycles.ts";
import { createPostgresTeam, listPostgresTeamStates } from "./postgres-teams.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL cycle auto-add", () => {
  integration("assigns active issues on direct ACTIVE creation and advance", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb623_auto_add",
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.created) throw new Error("PostgreSQL test schema was not empty");
      const viewer = await persistence.one<ActorRow>(
        "SELECT * FROM actors WHERE name = 'admin' LIMIT 1",
      );
      if (!viewer) throw new Error("PostgreSQL fixture has no admin actor");

      const horizonTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 PostgreSQL horizon",
          key: "P623HZ",
          cyclesEnabled: true,
          cycleUpcomingCount: 2,
        },
        viewer.id,
      );
      const horizon = await listPostgresCycles(persistence, horizonTeam.id);
      expect(horizon).toHaveLength(2);
      expect(horizon.every((cycle) => cycle.cadence_source === "cadence")).toBe(true);
      const horizonManual = await createPostgresCycle(persistence, viewer, {
        teamId: horizonTeam.id,
        name: "Manual stays",
        startsAt: "2035-01-01",
        endsAt: "2035-01-14",
      });
      await deletePostgresCycle(persistence, viewer, horizon[0]!.id);
      const replenished = await listPostgresCycles(persistence, horizonTeam.id);
      expect(replenished).toHaveLength(2);
      expect(replenished).toContainEqual(
        expect.objectContaining({
          id: horizonManual.id,
          starts_at: horizonManual.starts_at,
          ends_at: horizonManual.ends_at,
          cadence_source: "manual",
        }),
      );

      const orderTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 PostgreSQL order",
          key: "P623OR",
          cyclesEnabled: true,
          cycleDurationWeeks: 1,
          cycleUpcomingCount: 3,
        },
        viewer.id,
      );
      const orderCycles = await listPostgresCycles(persistence, orderTeam.id);
      const orderSecond = orderCycles.find((cycle) => cycle.number === 2);
      if (!orderSecond) throw new Error("PostgreSQL fixture has no second cycle");
      await updatePostgresCycle(persistence, viewer, orderSecond.id, {
        startsAt: "2030-01-01T00:00:00.000Z",
        endsAt: "2030-01-14T23:59:59.000Z",
      });
      const reordered = await listPostgresCycles(persistence, orderTeam.id);
      expect(reordered.map((cycle) => cycle.number)).toEqual([1, 2, 3]);
      expect(
        [...reordered]
          .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at))
          .map((cycle) => cycle.number),
      ).toEqual([1, 2, 3]);

      const defaultTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 default horizon active",
          key: "P623DH",
          cyclesEnabled: true,
          cycleAutoAddEnabled: true,
        },
        viewer.id,
      );
      const defaultActive = await createPostgresCycle(persistence, viewer, {
        teamId: defaultTeam.id,
        name: "Direct ACTIVE with horizon",
        state: "active",
        startsAt: "2026-09-01",
        endsAt: "2026-09-14",
      });
      const defaultCycles = await listPostgresCycles(persistence, defaultTeam.id);
      expect(defaultCycles.filter((cycle) => cycle.state === "upcoming")).toHaveLength(3);
      expect(
        defaultCycles.filter((cycle) => cycle.state === "upcoming").map((cycle) => cycle.number),
      ).toEqual([defaultActive.number + 1, defaultActive.number + 2, defaultActive.number + 3]);
      const advancedDefault = await advancePostgresCycle(persistence, viewer, defaultActive.id);
      expect(advancedDefault.cycle.number).toBe(defaultActive.number + 1);

      const directTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 direct auto-add",
          key: "P623DA",
          cyclesEnabled: true,
          cycleUpcomingCount: 0,
          cycleAutoAddEnabled: true,
        },
        viewer.id,
      );
      const directStarted = (await listPostgresTeamStates(persistence, directTeam.id)).find(
        (state) => state.type === "started",
      );
      if (!directStarted) throw new Error("PostgreSQL fixture has no started state");
      const directIssue = await createPostgresIssue(persistence, viewer, {
        teamId: directTeam.id,
        title: "Direct auto-add",
        stateId: directStarted.id,
      });
      const directCycle = await createPostgresCycle(persistence, viewer, {
        teamId: directTeam.id,
        name: "Direct ACTIVE",
        state: "active",
        startsAt: "2026-09-01",
        endsAt: "2026-09-14",
      });
      expect((await getPostgresIssue(persistence, directIssue.id))?.cycle_id).toBe(directCycle.id);
      const directActivity = await persistence.many<{ payload: string }>(
        "SELECT payload FROM activity WHERE issue_id = $1 AND type = 'cycle_changed'",
        [directIssue.id],
      );
      expect(directActivity.map((event) => JSON.parse(event.payload))).toContainEqual({
        from: null,
        to: directCycle.id,
        reason: "cycle_auto_add",
      });

      const advanceTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 advance auto-add",
          key: "P623AA",
          cyclesEnabled: true,
          cycleUpcomingCount: 0,
          cycleCooldownDays: 2,
          cycleAutoAddEnabled: true,
        },
        viewer.id,
      );
      const advanceStarted = (await listPostgresTeamStates(persistence, advanceTeam.id)).find(
        (state) => state.type === "started",
      );
      if (!advanceStarted) throw new Error("PostgreSQL fixture has no started state");
      const source = await createPostgresCycle(persistence, viewer, {
        teamId: advanceTeam.id,
        name: "Source ACTIVE",
        state: "active",
        startsAt: "2026-08-25",
        endsAt: "2026-09-07",
      });
      const advanceIssue = await createPostgresIssue(persistence, viewer, {
        teamId: advanceTeam.id,
        title: "Advance auto-add",
        stateId: advanceStarted.id,
      });
      const advanceCompleted = (await listPostgresTeamStates(persistence, advanceTeam.id)).find(
        (state) => state.type === "completed",
      );
      if (!advanceCompleted) throw new Error("PostgreSQL fixture has no completed state");
      const completedIssue = await createPostgresIssue(persistence, viewer, {
        teamId: advanceTeam.id,
        title: "Completed during cooldown",
        stateId: advanceCompleted.id,
      });
      const target = await createPostgresCycle(persistence, viewer, {
        teamId: advanceTeam.id,
        name: "Target UPCOMING",
        startsAt: "2026-09-15",
        endsAt: "2026-09-28",
      });
      const advanced = await advancePostgresCycle(persistence, viewer, source.id);
      expect(advanced.cycle).toMatchObject({ id: target.id, state: "active" });
      expect(advanced.movedIssues).toBe(2);
      expect((await getPostgresIssue(persistence, advanceIssue.id))?.cycle_id).toBe(target.id);
      expect((await getPostgresIssue(persistence, completedIssue.id))?.cycle_id).toBe(source.id);

      const disabledTeam = await createPostgresTeam(
        persistence,
        {
          name: "PRB-623 auto-add disabled",
          key: "P623OF",
          cyclesEnabled: true,
          cycleUpcomingCount: 0,
          cycleAutoAddEnabled: false,
        },
        viewer.id,
      );
      const disabledStarted = (await listPostgresTeamStates(persistence, disabledTeam.id)).find(
        (state) => state.type === "started",
      );
      if (!disabledStarted) throw new Error("PostgreSQL fixture has no started state");
      const disabledIssue = await createPostgresIssue(persistence, viewer, {
        teamId: disabledTeam.id,
        title: "Auto-add disabled",
        stateId: disabledStarted.id,
      });
      const disabledCycle = await createPostgresCycle(persistence, viewer, {
        teamId: disabledTeam.id,
        name: "Disabled ACTIVE",
        state: "active",
        startsAt: "2026-10-01",
        endsAt: "2026-10-14",
      });
      expect((await getPostgresIssue(persistence, disabledIssue.id))?.cycle_id).toBeNull();
      expect(
        (await listPostgresCycles(persistence, disabledTeam.id)).map((cycle) => cycle.id),
      ).toEqual([disabledCycle.id]);
    } finally {
      await persistence.close();
      await harness.close();
    }
  });
});
