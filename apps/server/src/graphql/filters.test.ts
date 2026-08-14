// Tests de AT-138: filtros componibles, full-text y paginación por cursor.
// Criterio: "mis issues urgentes sin empezar del team X que mencionen Y" en una llamada.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let teamId: string;
let adminId: string;
let todoId: string;
let urgentLabel: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id states { id type name } } viewer { id } }`);
  teamId = team.data!.team.id;
  adminId = team.data!.viewer.id;
  todoId = team.data!.team.states.find((s: any) => s.type === "UNSTARTED").id;
  const label = await gql(app, `mutation { labelCreate(input: { name: "urgent-path" }) { label { id } } }`);
  urgentLabel = label.data!.labelCreate.label.id;

  // Semilla: 5 issues con variedad de prioridad/estado/assignee/texto.
  const seed = [
    { title: "Fix webhook retries", priority: 1, state: todoId, assignee: adminId, labels: [urgentLabel] },
    { title: "Improve webhook payload docs", priority: 3, state: null, assignee: adminId, labels: [] },
    { title: "Polish UI shell", priority: 1, state: todoId, assignee: null, labels: [] },
    { title: "Add cursor pagination", priority: 2, state: null, assignee: adminId, labels: [] },
    { title: "Refactor webhook dispatcher queue", priority: 1, state: todoId, assignee: adminId, labels: [] },
  ];
  for (const item of seed) {
    const created = await gql(app, `
      mutation($title: String!, $priority: Int, $stateId: ID, $assigneeId: ID) {
        issueCreate(input: {
          teamKey: "PB", title: $title, priority: $priority, stateId: $stateId, assigneeId: $assigneeId
        }) { issue { id } }
      }
    `, { title: item.title, priority: item.priority, stateId: item.state, assigneeId: item.assignee });
    if (item.labels.length > 0) {
      await gql(app, `
        mutation($id: ID!, $labels: [ID!]) { issueUpdate(id: $id, input: { labelIds: $labels }) { success } }
      `, { id: created.data!.issueCreate.issue.id, labels: item.labels });
    }
  }
});
afterAll(() => app.stop());

describe("filtros componibles", () => {
  it("resuelve la query estrella del criterio de aceptación en una llamada", async () => {
    const result = await gql(app, `
      query($teamId: ID!, $adminId: ID!) {
        issues(filter: {
          team: { eq: $teamId }
          assignee: { eq: $adminId }
          priority: { eq: 1 }
          stateType: { eq: UNSTARTED }
          search: "webhook"
        }) { nodes { title } }
      }
    `, { teamId, adminId });
    expect(result.data!.issues.nodes.map((n: any) => n.title).sort()).toEqual([
      "Fix webhook retries",
      "Refactor webhook dispatcher queue",
    ]);
  });

  it("filtra por label y por prioridad acumulables con or", async () => {
    const result = await gql(app, `
      query($label: ID!) {
        issues(filter: {
          or: [
            { labels: { includes: $label } }
            { priority: { gte: 3 } }
          ]
        }) { nodes { title } }
      }
    `, { label: urgentLabel });
    expect(result.data!.issues.nodes.map((n: any) => n.title).sort()).toEqual([
      "Fix webhook retries",
      "Improve webhook payload docs",
    ]);
  });

  it("full-text busca en título y descripción", async () => {
    await gql(app, `
      mutation { issueUpdate(id: "PB-3", input: { description: "needs webhook love" }) { success } }
    `);
    const result = await gql(app, `{ issues(filter: { search: "webhook" }) { nodes { identifier } } }`);
    expect(result.data!.issues.nodes.length).toBe(4);
  });
});

describe("paginación por cursor", () => {
  it("recorre páginas estables sin repetir ni saltear", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const result: any = await gql(app, `
        query($after: String) {
          issues(first: 2, after: $after, orderBy: CREATED_ASC) {
            nodes { identifier }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { after: cursor });
      seen.push(...result.data.issues.nodes.map((n: any) => n.identifier));
      if (!result.data.issues.pageInfo.hasNextPage) break;
      cursor = result.data.issues.pageInfo.endCursor;
    }
    expect(seen).toEqual(["PB-1", "PB-2", "PB-3", "PB-4", "PB-5"]);
  });
});
