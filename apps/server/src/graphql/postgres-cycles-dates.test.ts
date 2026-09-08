// PRB-625: rechaza ajustes temporales inválidos de Cycles en PostgreSQL.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import type { Config } from "../config.ts";
import { createApp } from "../server.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

type GraphqlError = { message: string; extensions?: { code?: string } };
type GraphqlResponse<T> = { data?: T; errors?: GraphqlError[] };

type Cycle = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  state: string;
  cadenceSource: string;
  manuallyAdjusted?: boolean;
  archivedAt: string | null;
};

function dateFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("PostgreSQL cycles", () => {
  integration("rechaza fechas pasadas y conserva un ciclo UPCOMING", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb625_cycles",
      lockKey: `prb625-cycles-${randomUUID()}`,
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
        bootstrap: {
          workspaceName: "workspace",
          workspaceUrlKey: "workspace",
          teamName: "Prime Board",
          teamKey: "PB",
        },
      };
      const app = createApp({ db, config, persistence });
      stop = () => app.server.stop();

      const request = async <T>(
        query: string,
        variables?: Record<string, unknown>,
      ): Promise<GraphqlResponse<T>> => {
        const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${seeded.adminApiKey}`,
          },
          body: JSON.stringify({ query, variables }),
        });
        return (await response.json()) as GraphqlResponse<T>;
      };

      const teamResult = await request<{ teamCreate: { team: { id: string } } }>(
        `mutation {
          teamCreate(input: {
            name: "PRB-625 date guard", key: "G625",
            cyclesEnabled: true, cycleUpcomingCount: 0
          }) { team { id } }
        }`,
      );
      expect(teamResult.errors).toBeUndefined();
      const teamId = teamResult.data!.teamCreate.team.id;

      const created = await request<{ cycleCreate: { cycle: Cycle } }>(
        `mutation($teamId: ID!) {
          cycleCreate(input: {
            teamId: $teamId, name: "Future manual cycle",
            startsAt: "2040-01-01T00:00:00.000Z", endsAt: "2040-01-14T23:59:59.000Z"
          }) { cycle { id name startsAt endsAt state cadenceSource archivedAt } }
        }`,
        { teamId },
      );
      expect(created.errors).toBeUndefined();
      const cycle = created.data!.cycleCreate.cycle;
      const before = await request<{
        cycle: Cycle;
        cycles: Array<Pick<Cycle, "id">>;
      }>(
        `query($id: ID!, $teamId: ID!) {
          cycle(id: $id) { id name startsAt endsAt state cadenceSource archivedAt }
          cycles(teamId: $teamId) { id }
        }`,
        { id: cycle.id, teamId },
      );
      expect(before.errors).toBeUndefined();

      const rejectedStart = await request<unknown>(
        `mutation($id: ID!, $startsAt: DateTime!) {
          cycleUpdate(id: $id, input: { startsAt: $startsAt }) { success }
        }`,
        { id: cycle.id, startsAt: dateFromNow(-2) },
      );
      expect(rejectedStart.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

      const rejectedEnd = await request<unknown>(
        `mutation($id: ID!, $endsAt: DateTime!) {
          cycleUpdate(id: $id, input: { endsAt: $endsAt }) { success }
        }`,
        { id: cycle.id, endsAt: dateFromNow(-1) },
      );
      expect(rejectedEnd.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

      const after = await request<{
        cycle: Cycle;
        cycles: Array<Pick<Cycle, "id">>;
      }>(
        `query($id: ID!, $teamId: ID!) {
          cycle(id: $id) { id name startsAt endsAt state cadenceSource archivedAt }
          cycles(teamId: $teamId) { id }
        }`,
        { id: cycle.id, teamId },
      );
      expect(after.errors).toBeUndefined();
      expect(after.data!.cycle).toEqual(before.data!.cycle);
      expect(after.data!.cycles).toEqual(before.data!.cycles);

      const validStartsAt = dateFromNow(30);
      const validEndsAt = dateFromNow(37);
      const valid = await request<{ cycleUpdate: { success: boolean; cycle: Cycle } }>(
        `mutation($id: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleUpdate(id: $id, input: {
            name: "Manual future cycle", startsAt: $startsAt, endsAt: $endsAt
          }) {
            success cycle { id name startsAt endsAt state cadenceSource manuallyAdjusted archivedAt }
          }
        }`,
        { id: cycle.id, startsAt: validStartsAt, endsAt: validEndsAt },
      );
      expect(valid.errors).toBeUndefined();
      expect(valid.data!.cycleUpdate).toMatchObject({
        success: true,
        cycle: {
          id: cycle.id,
          name: "Manual future cycle",
          startsAt: validStartsAt,
          endsAt: validEndsAt,
          state: "UPCOMING",
          cadenceSource: "MANUAL",
          manuallyAdjusted: true,
          archivedAt: null,
        },
      });

      const active = await request<{ cycleCreate: { cycle: Cycle } }>(
        `mutation($teamId: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleCreate(input: {
            teamId: $teamId, name: "Started cycle", state: ACTIVE,
            startsAt: $startsAt, endsAt: $endsAt
          }) { cycle { id name startsAt endsAt state cadenceSource archivedAt } }
        }`,
        { teamId, startsAt: dateFromNow(40), endsAt: dateFromNow(47) },
      );
      expect(active.errors).toBeUndefined();
      const activeCycle = active.data!.cycleCreate.cycle;
      const activeRejected = await request<unknown>(
        `mutation($id: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleUpdate(id: $id, input: { startsAt: $startsAt, endsAt: $endsAt }) { success }
        }`,
        { id: activeCycle.id, startsAt: dateFromNow(50), endsAt: dateFromNow(57) },
      );
      expect(activeRejected.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

      const completed = await request<{ cycleCreate: { cycle: Cycle } }>(
        `mutation($teamId: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleCreate(input: {
            teamId: $teamId, name: "Completed cycle", state: COMPLETED,
            startsAt: $startsAt, endsAt: $endsAt
          }) { cycle { id name startsAt endsAt state cadenceSource archivedAt } }
        }`,
        { teamId, startsAt: dateFromNow(60), endsAt: dateFromNow(67) },
      );
      expect(completed.errors).toBeUndefined();
      const completedCycle = completed.data!.cycleCreate.cycle;
      const completedRejected = await request<unknown>(
        `mutation($id: ID!, $startsAt: DateTime!, $endsAt: DateTime!) {
          cycleUpdate(id: $id, input: { startsAt: $startsAt, endsAt: $endsAt }) { success }
        }`,
        { id: completedCycle.id, startsAt: dateFromNow(70), endsAt: dateFromNow(77) },
      );
      expect(completedRejected.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
