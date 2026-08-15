// Tests de AT-158: cada escritura queda replicada en el repo al instante.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
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
    expect(existsSync(join(repoDir, ".prime-board", "issues", "PB-1.md"))).toBe(true);
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

    const snapshot = readFileSync(join(repoDir, ".prime-board", "issues", "PB-1.md"), "utf8");
    expect(snapshot).toContain("state: In Progress");
    // El comentario vive en el log, no duplicado en el snapshot.
    expect(logFor("PB-1").at(-1)).toContain('"body":"listo"');
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

  it("una mutación toca solo los archivos de su issue (AT-166)", async () => {
    // Segundo issue para tener con qué comparar.
    await gql(app, `mutation { issueCreate(input: { teamKey: "PB", title: "Otro issue" }) { success } }`);
    const base = join(repoDir, ".prime-board");
    const mtimes = () => Object.fromEntries(
      readdirSync(join(base, "issues")).map((f) => [f, statSync(join(base, "issues", f)).mtimeMs]),
    );
    const logMtime = () => statSync(join(base, "log", "PB-1.jsonl")).mtimeMs;
    const before = mtimes();
    const beforeLog = logMtime();
    await new Promise((resolve) => setTimeout(resolve, 12));

    await gql(app, `mutation { commentCreate(input: { issueId: "PB-1", body: "solo PB-1" }) { success } }`);

    // El evento va al log de PB-1...
    expect(logMtime()).not.toBe(beforeLog);
    // ...y ningún snapshot se reescribe: el comentario vive en el log (AT-159),
    // así que ni siquiera PB-1.md cambia.
    expect(mtimes()).toEqual(before);
  });

  it("no reescribe archivos cuyo contenido no cambió", async () => {
    const base = join(repoDir, ".prime-board");
    const teamsFile = join(base, "meta", "teams.json");
    const before = statSync(teamsFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 12));
    // Un sync completo con metadata idéntica no debe tocar el archivo.
    await gql(app, `mutation { projectCreate(input: { name: "Proyecto nuevo" }) { success } }`);
    expect(statSync(teamsFile).mtimeMs).toBe(before);
  });
});
