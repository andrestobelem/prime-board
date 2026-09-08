import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeLinearExportToRepo, type LinearExport } from "./linear-repo-export.ts";
import { reconcileLinearExport } from "./linear-reconcile.ts";

const source: LinearExport = {
  workspace: { id: "00000000-0000-4000-8000-000000000101", name: "W" },
  actors: [],
  teams: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      key: "AT",
      name: "AT",
      states: [{ id: "00000000-0000-4000-8000-000000000103", name: "Todo", type: "unstarted" }],
    },
  ],
  labels: [],
  projects: [],
  comments: [],
  relations: [],
  issues: [
    {
      id: "00000000-0000-4000-8000-000000000104",
      identifier: "AT-1",
      number: 1,
      title: "Issue",
      teamId: "00000000-0000-4000-8000-000000000102",
      stateId: "00000000-0000-4000-8000-000000000103",
      creatorId: "00000000-0000-4000-8000-000000001004",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};

describe("reconcileLinearExport", () => {
  it("detecta una colisión antes de importar", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-reconcile-"));
    try {
      mkdirSync(join(root, ".prime-board", "issues"), { recursive: true });
      writeFileSync(
        join(root, ".prime-board", "issues", "AT-1.md"),
        "---\nid: AT-1\ntitle: Local\n---\n# Local\n",
      );
      const report = reconcileLinearExport(source, root);
      expect(report.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "IDENTIFIER_COLLISION" })]),
      );
      expect(report.reconciled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queda reconciliado después de escribir el export y el source map", () => {
    const root = mkdtempSync(join(process.cwd(), "scratchpad-linear-reconcile-ok-"));
    try {
      // Se usa un actor válido para que el conversor pueda producir el repo.
      const valid: LinearExport = {
        ...source,
        actors: [{ id: "00000000-0000-4000-8000-000000000105", name: "admin", type: "human" }],
        issues: [{ ...source.issues[0]!, creatorId: "00000000-0000-4000-8000-000000000105" }],
      };
      writeLinearExportToRepo(valid, root);
      const report = reconcileLinearExport(valid, root);
      expect(report).toMatchObject({
        reconciled: true,
        pendingCreates: [],
        conflicts: [],
        countMismatches: [],
      });
      expect(report.targetCounts).toMatchObject({ actors: 1, teams: 1, states: 1, issues: 1 });
      expect(report.targetIssues).toBe(1);
      writeFileSync(
        join(root, ".prime-board", "issues", "AT-1.md"),
        readFileSync(join(root, ".prime-board", "issues", "AT-1.md"), "utf8").replace(
          "title: Issue",
          "title: Changed",
        ),
      );
      const changed = reconcileLinearExport(valid, root);
      expect(changed.contentMismatches).toContain("AT-1.title: target=Changed, source=Issue");
      expect(changed.reconciled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
