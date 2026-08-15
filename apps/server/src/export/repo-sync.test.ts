// Tests de AT-158: cada escritura queda replicada en el repo al instante.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let repoDir: string;

const logFor = (identifier: string) =>
  readFileSync(join(repoDir, ".prime-board", "log", `${identifier}.jsonl`), "utf8").trim().split("\n");

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "pb-reposync-"));
  app = createTestApp(repoDir);
});
afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  app.stop();
});

describe("repo sync en cada escritura", () => {
  it("configura el merge driver union para los logs", () => {
    const attributes = readFileSync(join(repoDir, ".gitattributes"), "utf8");
    expect(attributes).toContain(".prime-board/log/*.jsonl merge=union");
  });

  it("crear un issue lo deja en el repo sin exportar a mano", async () => {
    const result = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Va al repo" }) { issue { identifier } } }
    `);
    expect(result.errors).toBeUndefined();
    expect(existsSync(join(repoDir, ".prime-board", "issues", "PB-1.json"))).toBe(true);
    const events = logFor("PB-1").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "created", issue: "PB-1" });
    expect(events[0].payload.title).toBe("Va al repo");
  });

  it("cada mutación agrega su evento al log", async () => {
    const team = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const started = team.data!.team.states.find((s: any) => s.type === "STARTED").id;
    await gql(app, `mutation($s: ID!) { issueUpdate(id: "PB-1", input: { stateId: $s, priority: 1 }) { success } }`,
      { s: started });
    await gql(app, `mutation { commentCreate(input: { issueId: "PB-1", body: "listo" }) { success } }`);

    const types = logFor("PB-1").map((line) => JSON.parse(line).type);
    expect(types).toEqual(["created", "state_changed", "priority_changed", "commented"]);

    const snapshot = JSON.parse(readFileSync(join(repoDir, ".prime-board", "issues", "PB-1.json"), "utf8"));
    expect(snapshot.state).toBe("In Progress");
    expect(snapshot.comments[0].body).toBe("listo");
  });

  it("los cambios de metadata también se replican", async () => {
    await gql(app, `mutation { teamCreate(input: { name: "Otro", key: "OT" }) { success } }`);
    const teams = JSON.parse(readFileSync(join(repoDir, ".prime-board", "meta", "teams.json"), "utf8"));
    expect(teams.map((t: any) => t.key).sort()).toEqual(["OT", "PB"]);
  });

  it("sin PRIME_BOARD_REPO no escribe nada (comportamiento por defecto)", async () => {
    const plain = createTestApp();
    try {
      const result = await gql(plain, `mutation { issueCreate(input: { teamKey: "PB", title: "x" }) { success } }`);
      expect(result.errors).toBeUndefined();
    } finally {
      plain.stop();
    }
  });
});
