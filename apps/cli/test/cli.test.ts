// Tests e2e de AT-140: el CLI contra un server real (subprocess con DB temporal).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PORT = 3394;
let tempDir: string;
let server: Bun.Subprocess;
let apiKey = "";

function pb(args: string[], stdin?: string) {
  const proc = Bun.spawnSync(["bun", join(ROOT, "apps/cli/src/index.ts"), ...args], {
    env: {
      ...process.env,
      PRIME_BOARD_URL: `http://localhost:${PORT}`,
      PRIME_BOARD_API_KEY: apiKey,
    },
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pb-cli-test-"));
  server = Bun.spawn(["bun", join(ROOT, "apps/server/src/index.ts")], {
    env: {
      ...process.env,
      PRIME_BOARD_DB: join(tempDir, "test.db"),
      PRIME_BOARD_PORT: String(PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Espera el arranque y captura la key impresa una única vez.
  const stdout = server.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
  }
  reader.releaseLock();
  const match = buffer.match(/Admin API key.*: (pb_\S+)/);
  if (!match) throw new Error(`No API key in server output: ${buffer}`);
  apiKey = match[1]!;
});

afterAll(() => {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pb auth", () => {
  it("status muestra el viewer autenticado", () => {
    const result = pb(["auth", "status"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.viewer.name).toBe("admin");
    expect(parsed.workspace.name).toBe("Prime Board");
  });
});

describe("pb issue", () => {
  it("crea un issue con prioridad y lo muestra", () => {
    const created = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "CLI issue",
      "--description",
      "made from cli",
      "--priority",
      "high",
      "--assignee",
      "me",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const issue = JSON.parse(created.out);
    expect(issue.identifier).toBe("PB-1");
    expect(issue.priority).toBe(2);
    expect(issue.assignee.name).toBe("admin");

    const view = pb(["issue", "view", "PB-1"]);
    expect(view.code).toBe(0);
    expect(view.out).toContain("CLI issue");
    expect(view.out).toContain("made from cli");
  });

  it("actualiza estado por nombre y lista con filtros", () => {
    const updated = pb(["issue", "update", "PB-1", "--state", "In Progress", "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.out).state.name).toBe("In Progress");

    const listed = pb(["issue", "list", "--team", "PB", "--state", "started", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("comenta leyendo el body de stdin", () => {
    const commented = pb(["issue", "comment", "PB-1", "--body", "-"], "stdin comment body");
    expect(commented.code).toBe(0);
    const view = pb(["issue", "view", "PB-1", "--json"]);
    expect(JSON.parse(view.out).comments[0].body).toBe("stdin comment body");
  });

  it("busca full-text desde el CLI", () => {
    pb(["issue", "create", "--team", "PB", "--title", "Unrelated thing"]);
    const found = pb(["issue", "list", "--search", "cli", "--json"]);
    expect(JSON.parse(found.out).nodes.length).toBe(1);
  });

  it("devuelve exit code 1 en errores de API y 2 en errores de uso", () => {
    const apiError = pb(["issue", "view", "PB-99"]);
    expect(apiError.code).toBe(2); // NOT_FOUND del CLI es UsageError con mensaje claro
    const usage = pb(["issue", "unknown-action"]);
    expect(usage.code).toBe(2);
    const badPriority = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "x",
      "--priority",
      "mega",
    ]);
    expect(badPriority.code).toBe(2);
    // Con una key inválida el server responde UNAUTHORIZED → exit 1.
    const invalid = Bun.spawnSync(["bun", join(ROOT, "apps/cli/src/index.ts"), "auth", "status"], {
      env: {
        ...process.env,
        PRIME_BOARD_URL: `http://localhost:${PORT}`,
        PRIME_BOARD_API_KEY: "pb_bad",
      },
    });
    expect(invalid.exitCode).toBe(1);
  });
});

describe("pb project / team / webhook", () => {
  it("crea y lista proyectos con lead y estado", () => {
    const created = pb([
      "project",
      "create",
      "--name",
      "Agent ops",
      "--state",
      "started",
      "--lead",
      "me",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const project = JSON.parse(created.out);
    expect(project.state).toBe("STARTED");
    expect(project.lead.name).toBe("admin");

    const listed = pb(["project", "list", "--state", "started", "--json"]);
    expect(JSON.parse(listed.out).map((p: any) => p.name)).toEqual(["Agent ops"]);

    // asocia un issue y lo ve en la vista del proyecto
    pb(["issue", "update", "PB-1", "--project", project.id]);
    const view = pb(["project", "view", project.id, "--json"]);
    expect(JSON.parse(view.out).issues.nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("administra el ciclo de vida de proyectos, milestones y updates", () => {
    const created = pb(["project", "create", "--name", "Lifecycle project", "--json"]);
    expect(created.code).toBe(0);
    const project = JSON.parse(created.out);

    const archived = pb(["project", "archive", project.id, "--json"]);
    expect(archived.code).toBe(0);
    expect(JSON.parse(archived.out).archivedAt).not.toBeNull();
    expect(
      JSON.parse(pb(["project", "list", "--json"]).out).map((item: any) => item.id),
    ).not.toContain(project.id);
    expect(
      JSON.parse(pb(["project", "list", "--include-archived", "--json"]).out).map(
        (item: any) => item.id,
      ),
    ).toContain(project.id);
    const unarchived = pb(["project", "unarchive", project.id, "--json"]);
    expect(unarchived.code).toBe(0);
    expect(JSON.parse(unarchived.out).archivedAt).toBeNull();

    const invalidPosition = pb([
      "project",
      "milestone-create",
      "--project",
      project.id,
      "--name",
      "Invalid",
      "--position",
      "not-a-number",
    ]);
    expect(invalidPosition.code).toBe(2);

    const milestone = pb([
      "project",
      "milestone-create",
      "--project",
      project.id,
      "--name",
      "Beta",
      "--json",
    ]);
    expect(milestone.code).toBe(0);
    const createdMilestone = JSON.parse(milestone.out);
    expect(createdMilestone.name).toBe("Beta");
    const milestoneUpdate = pb([
      "project",
      "milestone-update",
      createdMilestone.id,
      "--name",
      "Beta shipped",
      "--json",
    ]);
    expect(milestoneUpdate.code).toBe(0);
    expect(JSON.parse(milestoneUpdate.out).name).toBe("Beta shipped");
    const milestones = pb(["project", "milestone-list", project.id, "--json"]);
    expect(milestones.code).toBe(0);
    expect(JSON.parse(milestones.out).map((item: any) => item.name)).toEqual(["Beta shipped"]);

    const update = pb([
      "project",
      "update-create",
      "--project",
      project.id,
      "--health",
      "on_track",
      "--body",
      "Ready for beta",
      "--json",
    ]);
    expect(update.code).toBe(0);
    const createdUpdate = JSON.parse(update.out);
    expect(createdUpdate.body).toBe("Ready for beta");
    const updates = pb(["project", "update-list", project.id, "--json"]);
    expect(updates.code).toBe(0);
    expect(JSON.parse(updates.out).map((item: any) => item.id)).toEqual([createdUpdate.id]);

    expect(pb(["project", "update-delete", createdUpdate.id]).code).toBe(0);
    expect(pb(["project", "milestone-delete", createdMilestone.id]).code).toBe(0);
  });

  it("lista teams", () => {
    const result = pb(["team", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).map((t: any) => t.key)).toEqual(["PB"]);
  });

  it("crea, lista y borra webhooks mostrando el secret una sola vez", () => {
    const created = pb([
      "webhook",
      "create",
      "--url",
      "http://localhost:9/hook",
      "--events",
      "issue.created,comment.created",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const payload = JSON.parse(created.out);
    expect(payload.secret.length).toBeGreaterThan(10);
    expect(payload.webhook.events).toEqual(["issue.created", "comment.created"]);

    const listed = pb(["webhook", "list", "--json"]);
    expect(JSON.parse(listed.out).length).toBe(1);

    const deleted = pb(["webhook", "delete", payload.webhook.id]);
    expect(deleted.code).toBe(0);
    const after = pb(["webhook", "list", "--json"]);
    expect(JSON.parse(after.out).length).toBe(0);
  });
});

describe("pb planning, inbox and favorites", () => {
  it("opera cycles, reviews, initiatives, inbox y favorites", () => {
    const cycle = pb([
      "cycle",
      "create",
      "--team",
      "PB",
      "--name",
      "CLI cycle",
      "--starts-at",
      "2030-01-01",
      "--ends-at",
      "2030-01-14",
      "--json",
    ]);
    expect(cycle.code).toBe(0);
    const cycleId = JSON.parse(cycle.out).id;
    const secondCycle = pb([
      "cycle",
      "create",
      "--team",
      "PB",
      "--name",
      "CLI cycle 2",
      "--starts-at",
      "2030-02-01",
      "--ends-at",
      "2030-02-14",
      "--json",
    ]);
    expect(secondCycle.code).toBe(0);
    const secondCycleId = JSON.parse(secondCycle.out).id;
    expect(pb(["cycle", "list", "--team", "PB", "--json"]).code).toBe(0);
    expect(
      pb(["cycle", "carry-over", "--from", cycleId, "--to", secondCycleId, "--json"]).code,
    ).toBe(0);
    expect(pb(["cycle", "update", cycleId, "--state", "active", "--json"]).code).toBe(0);
    expect(pb(["cycle", "delete", cycleId]).code).toBe(0);
    expect(pb(["cycle", "delete", secondCycleId]).code).toBe(0);

    const issue = pb(["issue", "create", "--team", "PB", "--title", "CLI review target", "--json"]);
    const issueRef = JSON.parse(issue.out).identifier;
    const review = pb(["review", "create", "--issue", issueRef, "--reviewer", "me", "--json"]);
    expect(review.code).toBe(0);
    const reviewId = JSON.parse(review.out).id;
    expect(pb(["review", "list", "--open-only", "--json"]).code).toBe(0);
    expect(pb(["review", "update", reviewId, "--status", "approved", "--json"]).code).toBe(0);
    expect(pb(["review", "delete", reviewId]).code).toBe(0);

    const initiative = pb(["initiative", "create", "--name", "CLI initiative", "--json"]);
    expect(initiative.code).toBe(0);
    const initiativeId = JSON.parse(initiative.out).id;
    expect(pb(["initiative", "list", "--json"]).code).toBe(0);
    expect(pb(["initiative", "update", initiativeId, "--state", "active", "--json"]).code).toBe(0);
    expect(pb(["initiative", "delete", initiativeId]).code).toBe(0);

    const project = pb(["project", "create", "--name", "Favorite project", "--json"]);
    const projectId = JSON.parse(project.out).id;
    const favorite = pb(["favorite", "create", "--project", projectId, "--json"]);
    expect(favorite.code).toBe(0);
    const favoriteId = JSON.parse(favorite.out).id;
    expect(pb(["favorite", "list", "--json"]).code).toBe(0);
    expect(pb(["favorite", "reorder", favoriteId, "--position", "0", "--json"]).code).toBe(0);
    expect(pb(["favorite", "delete", favoriteId]).code).toBe(0);

    expect(pb(["inbox", "list", "--json"]).code).toBe(0);
    expect(pb(["inbox", "read", "missing-inbox-item"]).code).toBe(1);
    expect(pb(["inbox", "archive", "missing-inbox-item"]).code).toBe(1);
  });
});

describe("pb issue link / unlink (AT-179)", () => {
  it("linkea con --blocked-by y lo muestra en view", () => {
    pb(["issue", "create", "--team", "PB", "--title", "Blocker task"]);
    const linked = pb(["issue", "link", "PB-1", "--blocked-by", "PB-3", "--json"]);
    expect(linked.code).toBe(0);
    expect(JSON.parse(linked.out)).toMatchObject([
      { type: "BLOCKED_BY", relatedIssue: { identifier: "PB-3" } },
    ]);

    const view = pb(["issue", "view", "PB-1"]);
    expect(view.out).toContain("Relations:");
    expect(view.out).toContain("blocked by PB-3");

    // El otro extremo la ve como blocks.
    const other = pb(["issue", "view", "PB-3", "--json"]);
    expect(JSON.parse(other.out).relations).toMatchObject([
      { type: "BLOCKS", relatedIssue: { identifier: "PB-1" } },
    ]);
  });

  it("list --unblocked excluye al issue bloqueado", () => {
    const frontier = pb(["issue", "list", "--team", "PB", "--unblocked", "--json"]);
    expect(frontier.code).toBe(0);
    const identifiers = JSON.parse(frontier.out).nodes.map((n: any) => n.identifier);
    expect(identifiers).not.toContain("PB-1");
    expect(identifiers).toContain("PB-3");
  });

  it("devuelve exit code 1 cuando la relación cierra un ciclo", () => {
    const cycle = pb(["issue", "link", "PB-3", "--blocked-by", "PB-1"]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("cycle");
  });

  it("unlink borra la relación y sin flags es error de uso", () => {
    const missing = pb(["issue", "unlink", "PB-1"]);
    expect(missing.code).toBe(2);

    const unlinked = pb(["issue", "unlink", "PB-1", "--blocked-by", "PB-3", "--json"]);
    expect(unlinked.code).toBe(0);
    expect(JSON.parse(unlinked.out)).toEqual([]);

    const again = pb(["issue", "unlink", "PB-1", "--blocked-by", "PB-3"]);
    expect(again.code).toBe(1); // ya no existe → error de API
  });
});
