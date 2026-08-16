// PRB-223/224/226/222: fidelidad del rebuild desde el repo.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

describe("rebuild fidelity", () => {
  const app = createTestApp();
  afterAll(() => app.stop());

  it("restaura cycle, sort_order, inbox receipts y autoría legible", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id as string;

    const cycle = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: {
          teamId: $teamId, name: "Fidelity", startsAt: "2026-10-01", endsAt: "2026-10-14"
        }) { cycle { id number } }
      }`,
      { teamId },
    );
    const cycleId = cycle.data!.cycleCreate.cycle.id as string;
    const cycleNumber = cycle.data!.cycleCreate.cycle.number as number;

    const created = await gql(
      app,
      `mutation {
        issueCreate(input: { teamKey: "PB", title: "Fidelity issue" }) {
          issue { id identifier }
        }
      }`,
    );
    const issueId = created.data!.issueCreate.issue.id as string;
    const identifier = created.data!.issueCreate.issue.identifier as string;

    await gql(
      app,
      `mutation($id: ID!, $cycleId: ID!) {
        issueUpdate(id: $id, input: { cycleId: $cycleId, sortOrder: 42.5 }) { success }
      }`,
      { id: issueId, cycleId },
    );

    // Receipt de inbox: asignar a otro actor genera entrada; marcar leída.
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "fidelity-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id as string;
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "fidelity-key" }) { key }
        }`,
        { actorId: agentId },
      )
    ).data!.apiKeyCreate.key as string;

    await gql(
      app,
      `mutation($id: ID!, $assigneeId: ID!) {
        issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
      }`,
      { id: issueId, assigneeId: agentId },
    );

    const inbox = await gql(app, `{ inbox { id isRead } }`, {}, key);
    expect(inbox.data!.inbox.length).toBeGreaterThan(0);
    const firstId = inbox.data!.inbox[0].id as string;
    await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { success } }`,
      { id: firstId },
      key,
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-fidelity-"));
    try {
      exportBoard(app.db, dir);

      const md = readFileSync(join(dir, ".prime-board", "issues", `${identifier}.md`), "utf8");
      expect(md).toContain(`cycle: PB/${cycleNumber}`);
      expect(md).toContain("sortOrder: 42.5");
      expect(md).toContain("Created by admin.");

      const receipts = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "inbox-receipts.json"), "utf8"),
      ) as Array<{ issue: string; actor: string; readAt: string | null }>;
      expect(
        receipts.some((r) => r.issue === identifier && r.actor === "fidelity-agent" && r.readAt),
      ).toBe(true);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);

      const row = fresh
        .query(
          `SELECT i.sort_order, c.number AS cycle_number
           FROM issues i
           JOIN teams ON teams.id = i.team_id
           LEFT JOIN cycles c ON c.id = i.cycle_id
           WHERE teams.key || '-' || i.number = ?1`,
        )
        .get(identifier) as { sort_order: number; cycle_number: number | null };
      expect(row.sort_order).toBe(42.5);
      expect(row.cycle_number).toBe(cycleNumber);

      const restoredReceipts = fresh
        .query(
          `SELECT r.read_at IS NOT NULL AS is_read, actors.name AS actor
           FROM inbox_receipts r
           JOIN actors ON actors.id = r.actor_id
           JOIN activity a ON a.id = r.activity_id
           JOIN issues i ON i.id = a.issue_id
           JOIN teams ON teams.id = i.team_id
           WHERE teams.key || '-' || i.number = ?1`,
        )
        .all(identifier) as Array<{ is_read: number; actor: string }>;
      expect(restoredReceipts.some((r) => r.actor === "fidelity-agent" && r.is_read === 1)).toBe(
        true,
      );

      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
