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
    expect(parsed.workspace.name).toBe("workspace");
  });

  it("workspace update renombra y conserva urlKey", () => {
    const updated = pb(["workspace", "update", "--name", "CLI Workspace", "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.out)).toMatchObject({ name: "CLI Workspace", urlKey: "prime-board" });
    const viewed = pb(["workspace", "view", "--json"]);
    expect(JSON.parse(viewed.out)).toMatchObject({ name: "CLI Workspace", urlKey: "prime-board" });
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

    const reordered = pb(["issue", "update", "PB-1", "--sort-order", "12.5", "--json"]);
    expect(reordered.code).toBe(0);

    const listed = pb(["issue", "list", "--team", "PB", "--state", "started", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("asigna y muestra el cycle de un issue", () => {
    const issue = pb(["issue", "create", "--team", "PB", "--title", "Cycle target", "--json"]);
    expect(issue.code).toBe(0);
    const issueId = JSON.parse(issue.out).identifier;
    const cycle = pb([
      "cycle",
      "create",
      "--team",
      "PB",
      "--name",
      "CLI cycle",
      "--starts-at",
      "2026-01-01",
      "--ends-at",
      "2026-01-31",
      "--json",
    ]);
    expect(cycle.code).toBe(0);
    const cycleId = JSON.parse(cycle.out).id;
    const updated = pb(["issue", "update", issueId, "--cycle", cycleId, "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.out).cycle.name).toBe("CLI cycle");

    const cleared = pb(["issue", "update", issueId, "--cycle", "none", "--json"]);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(cleared.out).cycle).toBeNull();
  });

  it("limpia explícitamente la descripción de un issue", () => {
    const created = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "Description clear",
      "--description",
      "initial description",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const identifier = JSON.parse(created.out).identifier;
    const cleared = pb(["issue", "update", identifier, "--description", "none", "--json"]);
    expect(cleared.code).toBe(0);
    expect(JSON.parse(cleared.out).description).toBeNull();
  });

  it("rechaza valores inválidos de --first en issue list", () => {
    for (const value of ["oops", "0", "-1", "251"]) {
      const result = pb(["issue", "list", "--first", value, "--json"]);
      expect(result.code).toBe(2);
    }
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

  it("recorre páginas y expresa filtros compuestos", () => {
    const firstCreated = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "Pagination first",
      "--priority",
      "high",
      "--json",
    ]);
    const secondCreated = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "Pagination second",
      "--json",
    ]);
    expect(firstCreated.code).toBe(0);
    expect(secondCreated.code).toBe(0);
    const firstIdentifier = JSON.parse(firstCreated.out).identifier;
    const secondIdentifier = JSON.parse(secondCreated.out).identifier;
    const first = pb([
      "issue",
      "list",
      "--team",
      "PB",
      "--search",
      "Pagination",
      "--first",
      "1",
      "--order-by",
      "CREATED_ASC",
      "--json",
    ]);
    expect(first.code).toBe(0);
    const firstPage = JSON.parse(first.out);
    expect(firstPage.nodes).toHaveLength(1);
    expect(firstPage.pageInfo.endCursor).toBeTruthy();

    const second = pb([
      "issue",
      "list",
      "--team",
      "PB",
      "--search",
      "Pagination",
      "--first",
      "1",
      "--order-by",
      "CREATED_ASC",
      "--after",
      firstPage.pageInfo.endCursor,
      "--json",
    ]);
    expect(second.code).toBe(0);
    const secondPage = JSON.parse(second.out);
    expect(secondPage.nodes).toHaveLength(1);
    expect(secondPage.nodes[0].identifier).not.toBe(firstPage.nodes[0].identifier);
    expect([firstIdentifier, secondIdentifier]).toContain(firstPage.nodes[0].identifier);

    const filtered = pb([
      "issue",
      "list",
      "--team",
      "PB",
      "--filter",
      JSON.stringify({ and: [{ priority: { eq: 2 } }, { creator: { null: false } }] }),
      "--json",
    ]);
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.out).nodes.map((issue: any) => issue.identifier)).toContain(
      firstIdentifier,
    );
  });

  it("archiva issues e idempotentemente devuelve la issue archivada", () => {
    const created = pb([
      "issue",
      "create",
      "--team",
      "PB",
      "--title",
      "CLI archive target",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const issue = JSON.parse(created.out);
    const archived = pb(["issue", "archive", issue.identifier, "--json"]);
    expect(archived.code).toBe(0);
    expect(JSON.parse(archived.out).archivedAt).not.toBeNull();
    const again = pb(["issue", "archive", issue.identifier, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).archivedAt).toBe(JSON.parse(archived.out).archivedAt);
  });

  it("devuelve exit code 1 en errores de API y 2 en errores de uso", () => {
    const apiError = pb(["issue", "view", "PB-99"]);
    expect(apiError.code).toBe(1);
    expect(apiError.err).toContain("API error [NOT_FOUND]");
    expect(pb(["project", "view", "missing-project"]).code).toBe(1);
    expect(pb(["cycle", "view", "missing-cycle"]).code).toBe(1);
    expect(pb(["review", "view", "missing-review"]).code).toBe(1);
    expect(pb(["initiative", "view", "missing-initiative"]).code).toBe(1);
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
    const byName = pb(["issue", "update", "PB-1", "--project", "Agent ops", "--json"]);
    expect(byName.code).toBe(0);
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
    const milestoneByName = pb([
      "issue",
      "update",
      "PB-1",
      "--project",
      project.id,
      "--milestone",
      "Beta shipped",
      "--json",
    ]);
    expect(milestoneByName.code).toBe(0);
    expect(JSON.parse(milestoneByName.out).milestone.name).toBe("Beta shipped");

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

  it("lista teams y resuelve key o UUID sin ambigüedad", () => {
    const result = pb(["team", "list", "--json"]);
    expect(result.code).toBe(0);
    const teams = JSON.parse(result.out);
    expect(teams.map((t: any) => t.key)).toEqual(["PB"]);
    const byId = pb(["issue", "list", "--team", teams[0].id, "--json"]);
    expect(byId.code).toBe(0);
  });

  it("archiva y restaura teams sin perder sus issues", () => {
    const team = pb(["team", "create", "--name", "CLI archive team", "--key", "ARC", "--json"]);
    expect(team.code).toBe(0);
    const teamId = JSON.parse(team.out).id;
    const issue = pb(["issue", "create", "--team", "ARC", "--title", "Retained", "--json"]);
    expect(issue.code).toBe(0);
    expect(JSON.parse(issue.out).identifier).toBe("ARC-1");

    const archived = pb(["team", "archive", "ARC", "--json"]);
    expect(archived.code).toBe(0);
    expect(JSON.parse(archived.out)).toMatchObject({ id: teamId, key: "ARC" });
    expect(JSON.parse(archived.out).archivedAt).toBeTruthy();
    const hidden = pb(["team", "list", "--json"]);
    expect(JSON.parse(hidden.out).map((item: any) => item.key)).not.toContain("ARC");
    const history = pb(["team", "list", "--include-archived", "--json"]);
    expect(JSON.parse(history.out).find((item: any) => item.key === "ARC").archivedAt).toBeTruthy();

    const restored = pb(["team", "unarchive", "ARC", "--json"]);
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.out).archivedAt).toBeNull();
    const next = pb(["issue", "create", "--team", "ARC", "--title", "After restore", "--json"]);
    expect(next.code).toBe(0);
    expect(JSON.parse(next.out).identifier).toBe("ARC-2");
  });

  it("borra definitivamente un Team vacío con confirmación explícita", () => {
    const created = pb(["team", "create", "--name", "CLI disposable", "--key", "DCLI", "--json"]);
    expect(created.code).toBe(0);
    const mismatch = pb(["team", "delete", "DCLI", "--confirm", "WRONG"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain("VALIDATION_FAILED");
    const deleted = pb(["team", "delete", "DCLI", "--confirm", "DCLI", "--json"]);
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.out)).toEqual({ success: true });
    expect(pb(["team", "list", "--include-archived", "--json"]).out).not.toContain("DCLI");
  });

  it("administra teams, actors, memberships, estados, labels y API keys", () => {
    const team = pb(["team", "create", "--name", "CLI admin team", "--key", "ADM", "--json"]);
    expect(team.code).toBe(0);
    const renamed = pb(["team", "update", "ADM", "--name", "CLI managed team", "--json"]);
    expect(renamed.code).toBe(0);
    expect(JSON.parse(renamed.out).name).toBe("CLI managed team");

    const actor = pb([
      "actor",
      "create",
      "--name",
      "cli-managed-agent",
      "--type",
      "agent",
      "--json",
    ]);
    expect(actor.code).toBe(0);
    const actorId = JSON.parse(actor.out).id;
    const updatedActor = pb([
      "actor",
      "update",
      actorId,
      "--email",
      "agent@example.test",
      "--json",
    ]);
    expect(updatedActor.code).toBe(0);
    expect(JSON.parse(updatedActor.out).email).toBe("agent@example.test");

    const invitation = pb([
      "actor",
      "invite",
      "--email",
      "invited@example.test",
      "--type",
      "agent",
      "--json",
    ]);
    expect(invitation.code).toBe(0);
    const invitationPayload = JSON.parse(invitation.out);
    expect(invitationPayload.token).toMatch(/^pb_/);
    const acceptedInvite = pb([
      "actor",
      "accept-invite",
      "--token",
      invitationPayload.token,
      "--name",
      "cli-invited-agent",
      "--type",
      "agent",
      "--json",
    ]);
    expect(acceptedInvite.code).toBe(0);
    expect(JSON.parse(acceptedInvite.out).key).toMatch(/^pb_/);
    const suspended = pb(["actor", "suspend", actorId, "--json"]);
    expect(suspended.code).toBe(0);
    expect(JSON.parse(suspended.out).status).toBe("SUSPENDED");
    const reactivated = pb(["actor", "reactivate", actorId, "--json"]);
    expect(reactivated.code).toBe(0);
    expect(JSON.parse(reactivated.out).status).toBe("ACTIVE");

    const key = pb([
      "api-key",
      "create",
      "--actor",
      actorId,
      "--name",
      "CLI managed key",
      "--json",
    ]);
    expect(key.code).toBe(0);
    const keyPayload = JSON.parse(key.out);
    expect(keyPayload.key).toMatch(/^pb_/);
    const protectedIssue = JSON.parse(
      pb(["issue", "create", "--team", "PB", "--title", "CLI archive permission", "--json"]).out,
    );
    const forbidden = Bun.spawnSync(
      ["bun", join(ROOT, "apps/cli/src/index.ts"), "issue", "archive", protectedIssue.identifier],
      {
        env: {
          ...process.env,
          PRIME_BOARD_URL: `http://localhost:${PORT}`,
          PRIME_BOARD_API_KEY: keyPayload.key,
        },
      },
    );
    expect(forbidden.exitCode).toBe(1);
    expect(forbidden.stderr.toString()).toContain("UNAUTHORIZED");

    const membership = pb([
      "team",
      "membership-create",
      "--team",
      "ADM",
      "--actor",
      actorId,
      "--role",
      "member",
      "--json",
    ]);
    expect(membership.code).toBe(0);
    const membershipId = JSON.parse(membership.out).id;
    const memberships = pb(["team", "membership-list", "ADM", "--json"]);
    expect(JSON.parse(memberships.out).map((item: any) => item.actorId)).toContain(actorId);

    const state = pb([
      "team",
      "workflow-state-create",
      "--team",
      "ADM",
      "--name",
      "QA",
      "--type",
      "started",
      "--json",
    ]);
    expect(state.code).toBe(0);
    const stateId = JSON.parse(state.out).id;
    const renamedState = pb([
      "team",
      "workflow-state-update",
      stateId,
      "--name",
      "QA Ready",
      "--json",
    ]);
    expect(renamedState.code).toBe(0);
    expect(JSON.parse(renamedState.out).name).toBe("QA Ready");

    const label = pb(["team", "label-create", "--team", "ADM", "--name", "qa", "--json"]);
    expect(label.code).toBe(0);
    const labelId = JSON.parse(label.out).id;
    const renamedLabel = pb(["team", "label-update", labelId, "--name", "qa-ready", "--json"]);
    expect(renamedLabel.code).toBe(0);
    expect(JSON.parse(renamedLabel.out).name).toBe("qa-ready");
    expect(pb(["team", "label-delete", labelId, "--json"]).code).toBe(0);
    expect(pb(["team", "workflow-state-delete", stateId, "--json"]).code).toBe(0);
    expect(pb(["team", "membership-delete", membershipId, "--json"]).code).toBe(0);
    expect(pb(["api-key", "delete", keyPayload.apiKey.id, "--json"]).code).toBe(0);
    const revoked = pb(["actor", "revoke", actorId, "--json"]);
    expect(revoked.code).toBe(0);
    expect(JSON.parse(revoked.out).status).toBe("LEFT");
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

  it("unlink duplicate-of funciona desde ambos extremos", () => {
    const a = JSON.parse(
      pb(["issue", "create", "--team", "PB", "--title", "Duplicate source", "--json"]).out,
    );
    const b = JSON.parse(
      pb(["issue", "create", "--team", "PB", "--title", "Duplicate target", "--json"]).out,
    );
    expect(pb(["issue", "link", a.identifier, "--duplicate-of", b.identifier]).code).toBe(0);

    const fromInverse = pb([
      "issue",
      "unlink",
      b.identifier,
      "--duplicate-of",
      a.identifier,
      "--json",
    ]);
    expect(fromInverse.code).toBe(0);
    expect(JSON.parse(fromInverse.out)).toEqual([]);

    expect(pb(["issue", "link", a.identifier, "--duplicate-of", b.identifier]).code).toBe(0);
    const fromCanonical = pb([
      "issue",
      "unlink",
      a.identifier,
      "--duplicate-of",
      b.identifier,
      "--json",
    ]);
    expect(fromCanonical.code).toBe(0);
    expect(JSON.parse(fromCanonical.out)).toEqual([]);
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
