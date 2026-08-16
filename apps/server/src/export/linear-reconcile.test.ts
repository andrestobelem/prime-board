import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeLinearExportToRepo, type LinearExport } from "./linear-repo-export.ts";
import { reconcileLinearExport } from "./linear-reconcile.ts";

const source: LinearExport = {
  workspace: { id: "w", name: "W" },
  actors: [],
  teams: [
    { id: "t", key: "AT", name: "AT", states: [{ id: "s", name: "Todo", type: "unstarted" }] },
  ],
  labels: [],
  projects: [],
  comments: [],
  relations: [],
  issues: [
    {
      id: "i",
      identifier: "AT-1",
      number: 1,
      title: "Issue",
      teamId: "t",
      stateId: "s",
      creatorId: "missing",
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
        actors: [{ id: "a", name: "admin", type: "human" }],
        issues: [{ ...source.issues[0]!, creatorId: "a" }],
      };
      writeLinearExportToRepo(valid, root);
      const report = reconcileLinearExport(valid, root);
      expect(report).toMatchObject({ reconciled: true, pendingCreates: [], conflicts: [] });
      expect(report.targetIssues).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
