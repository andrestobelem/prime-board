// PRB-216: export/import de reviews e iniciativas.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("reviews e iniciativas export/import", () => {
  it("redondea iniciativas y reviews por export → rebuild", async () => {
    const project = await gql(
      app,
      `mutation { projectCreate(input: { name: "Export Project" }) { project { id name } } }`,
    );
    const projectId = project.data!.projectCreate.project.id;

    await gql(
      app,
      `mutation($projectIds: [ID!]!) {
        initiativeCreate(input: {
          name: "Export Initiative", state: ACTIVE, projectIds: $projectIds
        }) { initiative { id } }
      }`,
      { projectIds: [projectId] },
    );

    const reviewer = await gql(
      app,
      `mutation { actorCreate(input: { name: "export-reviewer", type: AGENT }) { actor { id } } }`,
    );
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "For review export" }) {
        issue { id identifier }
      } }`,
    );
    await gql(
      app,
      `mutation($input: ReviewCreateInput!) {
        reviewCreate(input: $input) { review { id } }
      }`,
      {
        input: {
          issueId: issue.data!.issueCreate.issue.id,
          reviewerId: reviewer.data!.actorCreate.actor.id,
        },
      },
    );

    const dir = mkdtempSync(join(tmpdir(), "pb-rev-init-"));
    try {
      exportBoard(app.db, dir);
      const initiatives = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "initiatives.json"), "utf8"),
      );
      expect(
        initiatives.some(
          (i: { name: string; projects: string[] }) =>
            i.name === "Export Initiative" && i.projects.includes("Export Project"),
        ),
      ).toBe(true);

      const reviews = JSON.parse(
        readFileSync(join(dir, ".prime-board", "meta", "reviews.json"), "utf8"),
      );
      expect(
        reviews.some(
          (r: { issue: string; reviewer: string }) =>
            r.issue === issue.data!.issueCreate.issue.identifier &&
            r.reviewer === "export-reviewer",
        ),
      ).toBe(true);

      const fresh = new Database(":memory:", { strict: true });
      fresh.exec("PRAGMA foreign_keys = ON;");
      migrate(fresh);
      rebuildFromRepo(fresh, dir);

      const restoredInitiatives = fresh
        .query("SELECT name FROM initiatives WHERE name = 'Export Initiative'")
        .all();
      expect(restoredInitiatives).toHaveLength(1);

      const restoredReviews = fresh
        .query(
          `SELECT r.status, a.name AS reviewer
           FROM reviews r JOIN actors a ON a.id = r.reviewer_id
           WHERE a.name = 'export-reviewer'`,
        )
        .all() as Array<{ status: string; reviewer: string }>;
      expect(restoredReviews).toHaveLength(1);
      expect(restoredReviews[0]!.status).toBe("requested");
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
