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
});
