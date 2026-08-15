// Tests de AT-177: filtro de issues desbloqueados (el frontier de /wayfinder).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let states: Array<{ id: string; type: string }>;
let workerId: string;

async function createIssue(title: string, extra: Record<string, unknown> = {}) {
  const result = await gql(app, `mutation($input: IssueCreateInput!) {
    issueCreate(input: $input) { issue { id identifier } }
  }`, { input: { teamKey: "PB", title, ...extra } });
  return result.data!.issueCreate.issue as { id: string; identifier: string };
}

async function frontier(filter: Record<string, unknown> = { unblocked: true }) {
  const result = await gql(app, `query($filter: IssueFilter) {
    issues(filter: $filter, orderBy: CREATED_ASC) { nodes { identifier } }
  }`, { filter });
  return result.data!.issues.nodes.map((node: any) => node.identifier) as string[];
}

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { states { id type } } }`);
  states = team.data!.team.states;
  const worker = await gql(app, `mutation { actorCreate(input: { name: "worker", type: AGENT }) { actor { id } } }`);
  workerId = worker.data!.actorCreate.actor.id;

  // PB-1 bloqueado por PB-2; PB-3 libre; PB-4 cerrado de entrada.
  await createIssue("Bloqueado");
  await createIssue("Bloqueante", { assigneeId: workerId });
  await createIssue("Libre");
  await createIssue("Cerrado");
  await gql(app, `mutation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success }
  }`, { input: { issueId: "PB-1", relatedIssueId: "PB-2", type: "BLOCKED_BY" } });
  const done = states.find((state) => state.type === "COMPLETED")!.id;
  await gql(app, `mutation($s: ID!) { issueUpdate(id: "PB-4", input: { stateId: $s }) { success } }`, { s: done });
});

afterAll(() => app.stop());

describe("issues(filter: { unblocked: true })", () => {
  it("excluye al issue con un bloqueante abierto e incluye a los demás abiertos", async () => {
    expect(await frontier()).toEqual(["PB-2", "PB-3"]);
  });

  it("unblocked: false devuelve exactamente los issues bloqueados", async () => {
    expect(await frontier({ unblocked: false })).toEqual(["PB-1"]);
  });

  it("se combina con los demás filtros (team, estado, assignee)", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    expect(await frontier({
      unblocked: true,
      team: { eq: team.data!.team.id },
      assignee: { eq: workerId },
    })).toEqual(["PB-2"]);
    expect(await frontier({ unblocked: true, stateType: { eq: BACKLOG_TYPE } })).toEqual(["PB-2", "PB-3"]);
  });

  it("cuando el bloqueante se cierra, el issue entra al frontier", async () => {
    const done = states.find((state) => state.type === "COMPLETED")!.id;
    await gql(app, `mutation($s: ID!) { issueUpdate(id: "PB-2", input: { stateId: $s }) { success } }`, { s: done });
    expect(await frontier()).toEqual(["PB-1", "PB-3"]);
  });

  it("un bloqueante cancelado tampoco bloquea", async () => {
    await createIssue("Otro bloqueado");
    await createIssue("Cancelado");
    await gql(app, `mutation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success }
    }`, { input: { issueId: "PB-5", relatedIssueId: "PB-6", type: "BLOCKED_BY" } });
    expect(await frontier()).toEqual(["PB-1", "PB-3", "PB-6"]);
    const canceled = states.find((state) => state.type === "CANCELED")!.id;
    await gql(app, `mutation($s: ID!) { issueUpdate(id: "PB-6", input: { stateId: $s }) { success } }`, { s: canceled });
    expect(await frontier()).toEqual(["PB-1", "PB-3", "PB-5"]);
  });
});

const BACKLOG_TYPE = "BACKLOG";
