import { describe, expect, it } from "bun:test";
import type { ActorRow } from "../auth/viewer.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { createPostgresIssue, getPostgresIssue } from "./postgres-issues.ts";
import {
  advancePostgresCycle,
  createPostgresCycle,
  listPostgresCycles,
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
        startsAt: "2026-09-01",
        endsAt: "2026-09-14",
      });
      const advanceIssue = await createPostgresIssue(persistence, viewer, {
        teamId: advanceTeam.id,
        title: "Advance auto-add",
        stateId: advanceStarted.id,
      });
      const target = await createPostgresCycle(persistence, viewer, {
        teamId: advanceTeam.id,
        name: "Target UPCOMING",
        startsAt: "2026-09-15",
        endsAt: "2026-09-28",
      });
      const advanced = await advancePostgresCycle(persistence, viewer, source.id);
      expect(advanced.cycle).toMatchObject({ id: target.id, state: "active" });
      expect(advanced.movedIssues).toBe(1);
      expect((await getPostgresIssue(persistence, advanceIssue.id))?.cycle_id).toBe(target.id);

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
