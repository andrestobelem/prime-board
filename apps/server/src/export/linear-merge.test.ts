import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { migrate } from "../db/database.ts";
import { rebuildFromRepo } from "./importer.ts";
import { mergeLinearExportWithRepo } from "./linear-merge.ts";
import type { LinearExport } from "./linear-repo-export.ts";

const source: LinearExport = {
  workspace: { id: "w", name: "W" },
  actors: [{ id: "a", name: "admin", type: "human" }],
  teams: [
    { id: "t", key: "AT", name: "Linear", states: [{ id: "s", name: "Todo", type: "unstarted" }] },
  ],
  labels: [],
  projects: [],
  comments: [],
  relations: [],
  issues: [
    {
      id: "linear-1",
      identifier: "AT-1",
      number: 1,
      title: "Linear",
      teamId: "t",
      stateId: "s",
      creatorId: "a",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};

const validSource: LinearExport = {
  ...source,
  workspace: { id: "00000000-0000-4000-8000-000000000001", name: "W" },
  actors: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "admin",
      type: "human",
    },
  ],
  teams: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      key: "AT",
      name: "Linear",
      states: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          name: "Todo",
          type: "unstarted",
        },
      ],
    },
  ],
  issues: [
    {
      ...source.issues[0]!,
      id: "00000000-0000-4000-8000-000000000005",
      teamId: "00000000-0000-4000-8000-000000000003",
      stateId: "00000000-0000-4000-8000-000000000004",
      creatorId: "00000000-0000-4000-8000-000000000002",
    },
  ],
};

function writeLocalRepo(root: string): void {
  const base = join(root, ".prime-board");
  for (const folder of ["meta", "issues", "log"])
    mkdirSync(join(base, folder), { recursive: true });
  writeFileSync(join(base, "meta", "workspace.json"), JSON.stringify({ name: "W", urlKey: "w" }));
  writeFileSync(
    join(base, "meta", "actors.json"),
    JSON.stringify([
      { name: "admin", email: null, type: "human" },
      { name: "claude", email: null, type: "agent" },
    ]),
  );
  writeFileSync(join(base, "meta", "workspace-labels.json"), "[]");
  writeFileSync(
    join(base, "meta", "projects.json"),
    JSON.stringify([
      {
        name: "Local",
        description: null,
        state: "started",
        lead: "claude",
        targetDate: null,
        archived: false,
        teams: ["AT"],
        milestones: [],
      },
    ]),
  );
  writeFileSync(
    join(base, "meta", "teams.json"),
    JSON.stringify([
      {
        key: "AT",
        name: "prime-board dev",
        description: null,
        defaultState: "Todo",
        states: [{ name: "Todo", type: "unstarted", color: "#aaa", position: 0 }],
        labels: [],
      },
    ]),
  );
  for (const [id, title] of [
    ["AT-1", "Linear"],
    ["AT-2", "Local"],
  ] as const) {
    writeFileSync(
      join(base, "issues", `${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\nteam: AT\nstate: Todo\npriority: 0\nassignee: null\ncreator: ${title === "Local" ? "claude" : "admin"}\nparent: null\nproject: ${title === "Local" ? "Local" : "null"}\nlabels: []\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\narchivedAt: null\n---\n\n# ${title}\n`,
    );
    writeFileSync(
      join(base, "log", `${id}.jsonl`),
      JSON.stringify({
        actor: title === "Local" ? "claude" : "admin",
        issue: id,
        type: "created",
        ts: "2026-01-01",
        payload: {
          title,
          description: null,
          team: "AT",
          number: Number(id.slice(3)),
          priority: 0,
          state: "Todo",
          assignee: null,
          parent: null,
          project: title === "Local" ? "Local" : null,
          milestone: null,
        },
      }) + "\n",
    );
  }
  writeFileSync(
    join(base, "issues", "AT-3.md"),
    "---\nid: AT-3\ntitle: Nieto\nteam: AT\nstate: Todo\npriority: 0\nassignee: null\ncreator: claude\nparent: AT-2\nproject: Local\nlabels: []\ncreatedAt: 2026-01-01\nupdatedAt: 2026-01-01\narchivedAt: null\n---\n\n# Nieto\n",
  );
  writeFileSync(
    join(base, "log", "AT-3.jsonl"),
    JSON.stringify({
      actor: "claude",
      issue: "AT-3",
      type: "created",
      ts: "2026-01-01",
      payload: {
        title: "Nieto",
        description: null,
        team: "AT",
        number: 3,
        priority: 0,
        state: "Todo",
        assignee: null,
        parent: "AT-2",
        project: "Local",
        milestone: null,
      },
    }) + "\n",
  );
}

describe("mergeLinearExportWithRepo", () => {
  it("conserva Linear en AT y rekeyea el ticket local colisionado a PRB", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const output = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-out-"));
    try {
      writeLocalRepo(local);
      const result = mergeLinearExportWithRepo(source, local, output);
      expect(result.rekeyed).toEqual({ "AT-2": "PRB-2", "AT-3": "PRB-3" });
      expect(readFileSync(join(output, ".prime-board", "issues", "AT-1.md"), "utf8")).toContain(
        "title: Linear",
      );
      expect(
        readFileSync(join(output, ".prime-board", "log", "AT-1.jsonl"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(2);
      expect(readFileSync(join(output, ".prime-board", "issues", "PRB-2.md"), "utf8")).toContain(
        "team: PRB",
      );
      const migrationReport = JSON.parse(
        readFileSync(join(output, ".prime-board", "meta", "migration-report.json"), "utf8"),
      );
      expect(migrationReport.localMerge.rekeyed).toEqual({ "AT-2": "PRB-2", "AT-3": "PRB-3" });
      const teams = JSON.parse(
        readFileSync(join(output, ".prime-board", "meta", "teams.json"), "utf8"),
      );
      expect(teams.map((team: any) => team.key).sort()).toEqual(["AT", "PRB"]);
      const db = new Database(":memory:", { strict: true });
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      expect(rebuildFromRepo(db, output).issues).toBe(3);
      db.close();
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("calcula REKEY_TEAM_EXISTS antes de publicar el destino", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const output = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-out-"));
    try {
      writeLocalRepo(local);
      const result = mergeLinearExportWithRepo(
        {
          ...source,
          teams: [{ ...source.teams[0]!, key: "PRB" }],
        },
        local,
        output,
      );
      expect(result.conflicts).toEqual([
        { code: "REKEY_TEAM_EXISTS", message: "Team PRB already exists" },
      ]);
      expect(existsSync(join(output, ".prime-board"))).toBe(false);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("calcula PROJECT_NAME_COLLISION antes de publicar el destino", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const output = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-out-"));
    try {
      writeLocalRepo(local);
      const result = mergeLinearExportWithRepo(
        {
          ...source,
          projects: [
            {
              id: "project-1",
              name: "Local",
              state: "started",
              teamIds: ["t"],
            },
          ],
        },
        local,
        output,
      );
      expect(result.conflicts).toEqual([
        {
          code: "PROJECT_NAME_COLLISION",
          message: "Project Local exists in both exports",
        },
      ]);
      expect(existsSync(join(output, ".prime-board"))).toBe(false);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("sale 1 y conserva SQLite cuando --apply encuentra un conflicto", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const output = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-out-"));
    const sourcePath = join(output, "linear.json");
    const databasePath = join(output, "sentinel.db");
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    try {
      writeLocalRepo(local);
      const cliSource: LinearExport = {
        ...source,
        workspace: { id: workspaceId, name: "W" },
        actors: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            name: "admin",
            type: "human",
          },
        ],
        teams: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            key: "PRB",
            name: "Linear",
            states: [
              {
                id: "00000000-0000-4000-8000-000000000004",
                name: "Todo",
                type: "unstarted",
              },
            ],
          },
        ],
        issues: [
          {
            ...source.issues[0]!,
            id: "00000000-0000-4000-8000-000000000005",
            teamId: "00000000-0000-4000-8000-000000000003",
            stateId: "00000000-0000-4000-8000-000000000004",
            creatorId: "00000000-0000-4000-8000-000000000002",
          },
        ],
      };
      writeFileSync(sourcePath, JSON.stringify(cliSource));

      const db = new Database(databasePath, { strict: true });
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      db.query(
        "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      ).run(workspaceId, "Sentinel", "sentinel", "2026-01-01");
      db.close();

      const serverRoot = join(import.meta.dir, "..", "..");
      const environment = {
        ...(process.env as Record<string, string>),
        PRIME_BOARD_DB: databasePath,
      };
      const command = Bun.spawnSync(
        [
          "bun",
          "src/scripts/import-linear.ts",
          "--from",
          sourcePath,
          "--merge-local",
          local,
          "--out",
          output,
          "--apply",
          "--json",
        ],
        { cwd: serverRoot, env: environment, stdout: "pipe", stderr: "pipe" },
      );
      expect(command.exitCode).toBe(1);
      expect(existsSync(join(output, ".prime-board"))).toBe(false);

      const reopened = new Database(databasePath, { strict: true });
      expect(
        (
          reopened.query("SELECT name FROM workspace WHERE id = ?1").get(workspaceId) as {
            name: string;
          }
        ).name,
      ).toBe("Sentinel");
      reopened.close();
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("limpia el staging si falla el rebuild y permite repetir el apply", () => {
    const local = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-local-"));
    const parent = mkdtempSync(join(process.cwd(), "scratchpad-linear-merge-atomic-"));
    const output = join(parent, "output");
    const sourcePath = join(output, "linear.json");
    const databasePath = join(output, "sentinel.db");
    const teamsPath = join(local, ".prime-board", "meta", "teams.json");
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const stagePrefix = ".output-linear-apply-";
    try {
      writeLocalRepo(local);
      mkdirSync(output, { recursive: true });
      writeFileSync(sourcePath, JSON.stringify(validSource));
      const teamsSnapshot = readFileSync(teamsPath, "utf8");
      rmSync(teamsPath);

      const db = new Database(databasePath, { strict: true });
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db);
      db.query(
        "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      ).run(workspaceId, "Sentinel", "sentinel", "2026-01-01");
      db.close();

      const serverRoot = join(import.meta.dir, "..", "..");
      const environment = {
        ...(process.env as Record<string, string>),
        PRIME_BOARD_DB: databasePath,
      };
      const runImport = () =>
        Bun.spawnSync(
          [
            "bun",
            "src/scripts/import-linear.ts",
            "--from",
            sourcePath,
            "--merge-local",
            local,
            "--out",
            output,
            "--apply",
            "--json",
          ],
          { cwd: serverRoot, env: environment, stdout: "pipe", stderr: "pipe" },
        );

      const failed = runImport();
      expect(failed.exitCode).toBe(1);
      expect(existsSync(join(output, ".prime-board"))).toBe(false);
      expect(readdirSync(parent).filter((entry) => entry.startsWith(stagePrefix))).toEqual([]);

      const afterFailure = new Database(databasePath, { strict: true });
      expect(
        (
          afterFailure.query("SELECT name FROM workspace WHERE id = ?1").get(workspaceId) as {
            name: string;
          }
        ).name,
      ).toBe("Sentinel");
      afterFailure.close();

      writeFileSync(teamsPath, teamsSnapshot);
      const retried = runImport();
      expect(retried.exitCode).toBe(0);
      expect(existsSync(join(output, ".prime-board"))).toBe(true);
      expect(readdirSync(parent).filter((entry) => entry.startsWith(stagePrefix))).toEqual([]);

      const afterRetry = new Database(databasePath, { strict: true });
      expect(
        (
          afterRetry.query("SELECT name FROM workspace WHERE id = ?1").get(workspaceId) as {
            name: string;
          }
        ).name,
      ).toBe("W");
      afterRetry.close();
    } finally {
      rmSync(local, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
