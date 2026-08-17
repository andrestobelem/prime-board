// Tests de AT-156: exportación determinista y sin credenciales.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBoard } from "./exporter.ts";
import { createSourceMap, readSourceMap, writeSourceMap } from "./source-map.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let dir: string;

beforeAll(async () => {
  app = createTestApp();
  dir = mkdtempSync(join(tmpdir(), "pb-export-"));
  const team = await gql(app, `{ team(key: "PB") { id states { id type } } }`);
  const teamId = team.data!.team.id;
  const project = await gql(
    app,
    `
    mutation($t: [ID!]) { projectCreate(input: { name: "Proyecto", teamIds: $t }) { project { id } } }
  `,
    { t: [teamId] },
  );
  const projectId = project.data!.projectCreate.project.id;
  const milestone = await gql(
    app,
    `
    mutation($p: ID!) { milestoneCreate(input: { projectId: $p, name: "Hito 1" }) { milestone { id } } }
  `,
    { p: projectId },
  );
  const label = await gql(
    app,
    `
    mutation($t: ID!) { labelCreate(input: { name: "bug", teamId: $t }) { label { id } } }
  `,
    { t: teamId },
  );
  const issue = await gql(
    app,
    `
    mutation($p: ID!, $m: ID!, $l: [ID!]) {
      issueCreate(input: {
        teamKey: "PB", title: "Exportame", description: "cuerpo", priority: 2,
        projectId: $p, milestoneId: $m, labelIds: $l
      }) { issue { id } }
    }
  `,
    {
      p: projectId,
      m: milestone.data!.milestoneCreate.milestone.id,
      l: [label.data!.labelCreate.label.id],
    },
  );
  await gql(
    app,
    `mutation { commentCreate(input: { issueId: "PB-1", body: "un comentario" }) { success } }`,
  );
  const started = team.data!.team.states.find((s: any) => s.type === "STARTED").id;
  await gql(
    app,
    `mutation($id: ID!, $s: ID!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`,
    { id: issue.data!.issueCreate.issue.id, s: started },
  );
  // Un webhook con secret y una API key: NO deben aparecer en el export.
  await gql(
    app,
    `mutation { webhookCreate(input: { url: "http://localhost:9/h", secret: "SUPERSECRET" }) { success } }`,
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  app.stop();
});

describe("exportBoard", () => {
  it("escribe meta, snapshot de issues y log de eventos", () => {
    const result = exportBoard(app.db, dir);
    expect(result.issues).toBe(1);
    expect(result.events).toBeGreaterThan(0);

    const base = join(dir, ".prime-board");
    expect(readdirSync(join(base, "meta")).sort()).toEqual([
      "actors.json",
      "cycles.json",
      "export.json",
      "favorites.json",
      "inbox-receipts.json",
      "initiatives.json",
      "project-updates.json",
      "projects.json",
      "reviews.json",
      "saved-views.json",
      "teams.json",
      "workspace-labels.json",
      "workspace.json",
    ]);
    expect(readdirSync(join(base, "issues"))).toEqual(["PB-1.md"]);
    expect(readdirSync(join(base, "log"))).toEqual(["PB-1.jsonl"]);
  });

  it("escribe markdown legible con front-matter y claves naturales", () => {
    const raw = readFileSync(join(dir, ".prime-board", "issues", "PB-1.md"), "utf8");
    // Front-matter YAML con claves naturales.
    for (const line of [
      "id: PB-1",
      "team: PB",
      "state: In Progress",
      "priority: 2",
      "creator: admin",
      "project: Proyecto",
      "milestone: Hito 1",
    ]) {
      expect(raw).toContain(line);
    }
    // Título y descripción como markdown de verdad.
    expect(raw).toContain("# Exportame");
    expect(raw).toContain("cuerpo");
    // Ningún UUID suelto.
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("traduce los ids del log a nombres legibles", () => {
    const lines = readFileSync(join(dir, ".prime-board", "log", "PB-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    const events = lines.map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "created", actor: "admin", issue: "PB-1" });
    const stateChange = events.find((e) => e.type === "state_changed");
    expect(stateChange.payload.to).toBe("In Progress");
  });

  it("es determinista: exportar dos veces no cambia nada", () => {
    const snapshot = () => {
      const base = join(dir, ".prime-board");
      const out: Record<string, string> = {};
      for (const folder of ["meta", "issues", "log"]) {
        for (const file of readdirSync(join(base, folder))) {
          out[`${folder}/${file}`] = readFileSync(join(base, folder, file), "utf8");
        }
      }
      return out;
    };
    const first = snapshot();
    exportBoard(app.db, dir);
    expect(snapshot()).toEqual(first);
  });

  it("NUNCA exporta credenciales (hashes de keys ni secrets de webhooks)", () => {
    const base = join(dir, ".prime-board");
    let all = "";
    for (const folder of ["meta", "issues", "log"]) {
      for (const file of readdirSync(join(base, folder))) {
        all += readFileSync(join(base, folder, file), "utf8");
      }
    }
    expect(all).not.toContain("SUPERSECRET");
    expect(all).not.toContain(app.apiKey);
    expect(all.toLowerCase()).not.toContain("hash");
    expect(all).not.toContain("secret");
  });

  it("puede exportar un solo team", () => {
    const only = mkdtempSync(join(tmpdir(), "pb-export-team-"));
    try {
      const result = exportBoard(app.db, only, { teamKey: "PB" });
      expect(result.issues).toBe(1);
      expect(() => exportBoard(app.db, only, { teamKey: "NOPE" })).toThrow();
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });

  it("preserva el mapa de origen de una migración", () => {
    const map = createSourceMap("linear-workspace");
    writeSourceMap(dir, map);
    exportBoard(app.db, dir);
    expect(readSourceMap(dir)).toEqual(map);
  });

  it("el evento created trae el estado inicial completo (AT-165)", () => {
    const lines = readFileSync(join(dir, ".prime-board", "log", "PB-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    const created = JSON.parse(lines[0]!);
    expect(created.type).toBe("created");
    // Sin esto el log no alcanza para reconstruir el issue sin el snapshot.
    expect(created.payload).toMatchObject({
      title: "Exportame",
      description: "cuerpo",
      number: 1,
      priority: 2,
      team: "PB",
      project: "Proyecto",
      milestone: "Hito 1",
    });
  });

  it("no filtra UUIDs internos en los eventos", () => {
    const lines = readFileSync(join(dir, ".prime-board", "log", "PB-1.jsonl"), "utf8");
    expect(lines).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    // El comentario conserva el body, que es lo que importa para reconstruirlo.
    expect(lines).toContain('"body":"un comentario"');
  });

  it("recupera el body de comentarios de eventos viejos (sin body en el payload)", () => {
    // Simula un evento anterior a AT-165: solo commentId, sin body.
    const comment = app.db.query("SELECT id FROM comments LIMIT 1").get() as { id: string };
    app.db
      .query("UPDATE activity SET payload = ?1 WHERE type = 'commented'")
      .run(JSON.stringify({ commentId: comment.id }));

    exportBoard(app.db, dir);
    const log = readFileSync(join(dir, ".prime-board", "log", "PB-1.jsonl"), "utf8");
    // El body se completa desde la tabla: sin esto el rebuild perdería el comentario.
    expect(log).toContain('"body":"un comentario"');
    expect(log).not.toContain(comment.id);
  });
});
