// Tests de AT-180: el estado default de un team es explícito, no "el de menor posición".
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let states: Array<{ id: string; name: string; type: string; position: number }>;
let teamId: string;

async function teamState() {
  const result = await gql(app, `{ team(key: "PB") { id defaultState { id name } states { id name type position } } }`);
  return result.data!.team;
}

async function createIssue(title: string) {
  const result = await gql(app, `mutation($t: String!) {
    issueCreate(input: { teamKey: "PB", title: $t }) { issue { identifier state { name } } }
  }`, { t: title });
  return result.data!.issueCreate.issue;
}

beforeAll(async () => {
  app = createTestApp();
  const team = await teamState();
  teamId = team.id;
  states = team.states;
});

afterAll(() => app.stop());

describe("estado default explícito por team", () => {
  it("un team nuevo arranca con Backlog como default explícito", async () => {
    const team = await teamState();
    expect(team.defaultState.name).toBe("Backlog");
  });

  it("reordenar estados ya no cambia el default (el footgun de AT-180)", async () => {
    // Un estado nuevo pasa a la posición más baja, como Needs Triage en AT-173.
    await gql(app, `mutation($input: WorkflowStateCreateInput!) {
      workflowStateCreate(input: $input) { workflowState { id } }
    }`, { input: { teamId, name: "Needs Triage", type: "TRIAGE", position: -1 } });

    const team = await teamState();
    expect(team.defaultState.name).toBe("Backlog");
    const issue = await createIssue("Sigue cayendo en Backlog");
    expect(issue.state.name).toBe("Backlog");
  });

  it("teamUpdate cambia el default y los issues nuevos caen ahí", async () => {
    const triage = (await teamState()).states.find((state: any) => state.name === "Needs Triage")!;
    const updated = await gql(app, `mutation($id: ID!, $input: TeamUpdateInput!) {
      teamUpdate(id: $id, input: $input) { team { defaultState { name } } }
    }`, { id: teamId, input: { defaultStateId: triage.id } });
    expect(updated.data!.teamUpdate.team.defaultState.name).toBe("Needs Triage");

    const issue = await createIssue("Cae en triage");
    expect(issue.state.name).toBe("Needs Triage");
  });

  it("rechaza un default que no pertenece al team", async () => {
    const other = await gql(app, `mutation {
      teamCreate(input: { name: "Otro", key: "OT" }) { team { states { id } } }
    }`);
    const foreign = other.data!.teamCreate.team.states[0].id;
    const result = await gql(app, `mutation($id: ID!, $input: TeamUpdateInput!) {
      teamUpdate(id: $id, input: $input) { success }
    }`, { id: teamId, input: { defaultStateId: foreign } });
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("borrar el estado default lo reasigna en vez de dejarlo colgando", async () => {
    const team = await teamState();
    const triage = team.states.find((state: any) => state.name === "Needs Triage")!;
    const backlog = team.states.find((state: any) => state.name === "Backlog")!;
    await gql(app, `mutation($id: ID!, $to: ID) {
      workflowStateDelete(id: $id, moveToStateId: $to) { success }
    }`, { id: triage.id, to: backlog.id });
    const after = await teamState();
    expect(after.defaultState.name).toBe("Backlog");
  });

  it("el default sobrevive un rebuild desde el repo", async () => {
    // Un default distinto del de menor posición, para que el fallback no lo tape.
    const done = (await teamState()).states.find((state: any) => state.name === "Done")!;
    await gql(app, `mutation($id: ID!, $input: TeamUpdateInput!) {
      teamUpdate(id: $id, input: $input) { success }
    }`, { id: teamId, input: { defaultStateId: done.id } });

    const dir = mkdtempSync(join(tmpdir(), "pb-default-state-"));
    try {
      exportBoard(app.db, dir);
      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);
      const row = fresh.query(
        `SELECT workflow_states.name FROM teams
         JOIN workflow_states ON workflow_states.id = teams.default_state_id
         WHERE teams.key = 'PB'`,
      ).get() as { name: string };
      expect(row.name).toBe("Done");
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
