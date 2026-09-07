import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceEventLog, regenerateCanonicalProjections } from "./canonical-projection.ts";
import { importMarkdownEvents } from "./markdown-event-import.ts";
import { EventLogWriter, type DomainEvent, type JsonObject } from "./event-log.ts";

const issueEvent = (eventId: string, type: string, payload: JsonObject): DomainEvent => ({
  schemaVersion: 1,
  eventId,
  aggregate: "issue",
  aggregateKey: "PB-1",
  type,
  actor: "actor-1",
  workspaceId: "workspace-1",
  occurredAt: `2025-01-01T00:00:0${eventId === "one" ? "0" : "1"}.000Z`,
  payload,
});

describe("canonical event reducer", () => {
  it("reduces issue snapshots and field changes without a database", () => {
    const projection = reduceEventLog([
      issueEvent("one", "issue.created", {
        id: "issue-1",
        title: "Initial",
        description: "Body",
        team: "PB",
        state: "Todo",
        priority: 2,
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      issueEvent("two", "issue.updated", {
        title: "Updated",
        changes: { priority: { from: 2, to: 1 } },
      }),
    ]);
    expect(projection.issues).toHaveLength(1);
    expect(projection.issues[0]).toMatchObject({
      title: "Updated",
      priority: 1,
      description: "Body",
    });
  });

  it("no expone la marca interna de Activity en la proyección canónica", () => {
    const projection = reduceEventLog([
      issueEvent("activity", "updated", {
        issueId: "issue-1",
        title: "Changed",
        __source: "activity",
      }),
    ]);
    expect(projection.events[0]?.payload).toEqual({ issueId: "issue-1", title: "Changed" });
    expect(projection.aggregates[0]?.payload).toEqual({
      issueId: "issue-1",
      title: "Changed",
    });
  });

  it("folds snapshot relation rows into deterministic Issue projections", () => {
    const timestamp = "2025-01-01T00:00:00.000Z";
    const snapshot = (aggregate: string, key: string, payload: JsonObject): DomainEvent => ({
      schemaVersion: 1,
      eventId: `sqlite:${aggregate}:${key}`,
      aggregate,
      aggregateKey: key,
      type: "snapshot_imported",
      actor: { source: "sqlite", table: aggregate },
      workspaceId: "workspace-1",
      occurredAt: timestamp,
      payload,
    });
    const issue = (id: string, identifier: string): DomainEvent =>
      snapshot("issue", id, {
        id,
        identifier,
        team_id: "team-one",
        team_key: "PB",
        number: Number(identifier.split("-")[1]),
        title: identifier,
        state_id: "state-one",
        creator_id: "actor-one",
        priority: 0,
        sort_order: 0,
        created_at: timestamp,
        updated_at: timestamp,
        description: null,
        assignee_id: null,
        parent_id: null,
        project_id: null,
        milestone_id: null,
        cycle_id: null,
        archived_at: null,
      });
    const projection = reduceEventLog([
      issue("issue-one", "PB-1"),
      issue("issue-two", "PB-2"),
      snapshot("label", "label-one", { id: "label-one", name: "bug", team_id: null }),
      snapshot("issue_label", '["issue-one","label-one"]', {
        issue_id: "issue-one",
        label_id: "label-one",
      }),
      snapshot("issue_relation", "relation-one", {
        id: "relation-one",
        issue_id: "issue-two",
        related_id: "issue-one",
        type: "blocks",
        created_at: timestamp,
      }),
    ]);
    expect(projection.issues[0]).toMatchObject({ identifier: "PB-1", blockedBy: ["PB-2"] });
    expect(projection.issues[0]?.labels).toEqual([{ name: "bug", team: null }]);
  });

  it("regenerates markdown and canonical metadata from only the log", () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-projection-"));
    const writer = new EventLogWriter({ rootDir: root });
    writer.append(
      issueEvent("one", "issue.created", {
        id: "issue-1",
        title: "From log",
        description: "Description",
        team: "PB",
        state: "Todo",
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
    );
    const result = regenerateCanonicalProjections(root);
    expect(result.issues).toBe(1);
    const markdown = readFileSync(join(root, ".prime-board", "issues", "PB-1.md"), "utf8");
    expect(markdown).toContain("title: From log");
    expect(markdown).toContain("Description");
    expect(existsSync(join(root, ".prime-board", "meta", "canonical.json"))).toBe(true);
  });

  it("imports Markdown by appending events and never receives a database writer", () => {
    const root = mkdtempSync(join(tmpdir(), "markdown-events-"));
    const issues = join(root, ".prime-board", "issues");
    mkdirSync(issues, { recursive: true });
    writeFileSync(
      join(issues, "PB-2.md"),
      "---\nid: PB-2\ntitle: Imported\nteam: PB\nstate: Todo\n---\n\n# Imported\n\nBody\n",
    );
    const committed: string[][] = [];
    const result = importMarkdownEvents({
      rootDir: root,
      actor: "actor-1",
      commit: (eventIds) => committed.push([...eventIds]),
    });
    expect(result).toMatchObject({ scanned: 1, emitted: 1, duplicates: 0 });
    expect(committed).toHaveLength(1);
    expect(readFileSync(join(root, ".prime-board", "log", "events.jsonl"), "utf8")).toContain(
      '"aggregate":"issue"',
    );
  });
});
