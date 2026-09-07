import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { getIssue, type IssueRow } from "./issues.ts";

/** Razones estables para que un worker pueda explicar por qué no actuó. */
export type AutomationEligibilityReason =
  | "eligible"
  | "not_configured"
  | "archived"
  | "already_closed"
  | "recently_updated"
  | "active_cycle"
  | "unfinished_project"
  | "pending_sub_issue"
  | "parent_issues_disabled"
  | "child_issues_disabled"
  | "missing_canceled_state"
  | "missing_completed_state";

export interface AutomationDecision {
  eligible: boolean;
  reason: AutomationEligibilityReason;
  targetStateId?: string;
}

interface AutomationIssueRow extends IssueRow {
  state_type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
  auto_close_period: number | null;
  auto_archive_period: number | null;
  auto_close_state_id: string | null;
  auto_close_parent_issues: number | null;
  auto_close_child_issues: number | null;
  team_archived_at: string | null;
}

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);
const DAY_MS = 86_400_000;

function dueAt(updatedAt: string, period: number | null, nowMs: number): boolean {
  if (period == null) return false;
  const updatedMs = Date.parse(updatedAt);
  return Number.isFinite(updatedMs) && updatedMs + period * DAY_MS <= nowMs;
}

function isOpen(stateType: string): boolean {
  return !CLOSED_STATE_TYPES.has(stateType);
}

function loadAutomationIssue(
  db: Database,
  issueId: string,
  workspaceId?: string,
): AutomationIssueRow | null {
  const workspace = workspaceId ? " AND issues.workspace_id = ?2" : "";
  return (
    workspaceId
      ? db
          .query(
            `SELECT issues.*, teams.key AS team_key, workflow_states.type AS state_type,
                    teams.auto_close_period, teams.auto_archive_period,
                    teams.auto_close_state_id, teams.auto_close_parent_issues,
                    teams.auto_close_child_issues, teams.archived_at AS team_archived_at
             FROM issues
             JOIN teams ON teams.id = issues.team_id
             JOIN workflow_states ON workflow_states.id = issues.state_id
             WHERE issues.id = ?1${workspace}`,
          )
          .get(issueId, workspaceId)
      : db
          .query(
            `SELECT issues.*, teams.key AS team_key, workflow_states.type AS state_type,
                    teams.auto_close_period, teams.auto_archive_period,
                    teams.auto_close_state_id, teams.auto_close_parent_issues,
                    teams.auto_close_child_issues, teams.archived_at AS team_archived_at
             FROM issues
             JOIN teams ON teams.id = issues.team_id
             JOIN workflow_states ON workflow_states.id = issues.state_id
             WHERE issues.id = ?1`,
          )
          .get(issueId)
  ) as AutomationIssueRow | null;
}

function descendants(
  db: Database,
  issueId: string,
  workspaceId?: string,
): Array<{
  id: string;
  state_type: string;
  project_id: string | null;
  cycle_id: string | null;
  archived_at: string | null;
}> {
  const workspace = workspaceId ? " AND issues.workspace_id = ?2" : "";
  const query = `
    WITH RECURSIVE children(id, state_type, project_id, cycle_id, archived_at) AS (
      SELECT issues.id, workflow_states.type, issues.project_id, issues.cycle_id, issues.archived_at
      FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
      WHERE issues.parent_id = ?1${workspace}
      UNION ALL
      SELECT issues.id, workflow_states.type, issues.project_id, issues.cycle_id, issues.archived_at
      FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
      JOIN children ON children.id = issues.parent_id
      WHERE 1 = 1${workspace.replaceAll("?2", "?2")}
    ) SELECT * FROM children`;
  return (
    workspaceId ? db.query(query).all(issueId, workspaceId) : db.query(query).all(issueId)
  ) as Array<{
    id: string;
    state_type: string;
    project_id: string | null;
    cycle_id: string | null;
    archived_at: string | null;
  }>;
}

function hasActiveCycle(
  db: Database,
  issue: AutomationIssueRow,
  children: ReturnType<typeof descendants>,
  workspaceId?: string,
): boolean {
  const ids = [issue.id, ...children.map((child) => child.id)];
  if (ids.length === 0) return false;
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const workspace = workspaceId ? ` AND cycles.workspace_id = ?${ids.length + 1}` : "";
  const params: unknown[] = [...ids];
  if (workspaceId) params.push(workspaceId);
  const row = db
    .query(
      `SELECT 1 FROM issues JOIN cycles ON cycles.id = issues.cycle_id
       WHERE issues.id IN (${placeholders}) AND cycles.state = 'active'${workspace} LIMIT 1`,
    )
    .get(...(params as never[]));
  return Boolean(row);
}

function hasUnfinishedProject(
  db: Database,
  issue: AutomationIssueRow,
  children: ReturnType<typeof descendants>,
  workspaceId?: string,
): boolean {
  const ids = [issue.project_id, ...children.map((child) => child.project_id)].filter(
    (id): id is string => id !== null,
  );
  if (ids.length === 0) return false;
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(", ");
  const workspace = workspaceId ? ` AND projects.workspace_id = ?${ids.length + 1}` : "";
  const params: unknown[] = [...ids];
  if (workspaceId) params.push(workspaceId);
  const row = db
    .query(
      `SELECT 1 FROM projects
       WHERE projects.id IN (${placeholders})
         AND projects.state NOT IN ('completed', 'canceled')${workspace} LIMIT 1`,
    )
    .get(...(params as never[]));
  return Boolean(row);
}

function hasPendingChildren(children: ReturnType<typeof descendants>): boolean {
  return children.some((child) => !child.archived_at && isOpen(child.state_type));
}

function targetCompletedState(
  db: Database,
  issue: AutomationIssueRow,
  workspaceId?: string,
): string | null {
  if (issue.auto_close_state_id) {
    const row = workspaceId
      ? db
          .query(
            "SELECT id, type FROM workflow_states WHERE id = ?1 AND team_id = ?2 AND workspace_id = ?3",
          )
          .get(issue.auto_close_state_id, issue.team_id, workspaceId)
      : db
          .query("SELECT id, type FROM workflow_states WHERE id = ?1 AND team_id = ?2")
          .get(issue.auto_close_state_id, issue.team_id);
    if (row && (row as { type: string }).type === "completed") return (row as { id: string }).id;
    return null;
  }
  const workspace = workspaceId ? " AND workspace_id = ?2" : "";
  const row = workspaceId
    ? db
        .query(
          `SELECT id FROM workflow_states WHERE team_id = ?1 AND type = 'completed'${workspace} ORDER BY position, id LIMIT 1`,
        )
        .get(issue.team_id, workspaceId)
    : db
        .query(
          "SELECT id FROM workflow_states WHERE team_id = ?1 AND type = 'completed' ORDER BY position, id LIMIT 1",
        )
        .get(issue.team_id);
  return row ? (row as { id: string }).id : null;
}

/** Evalúa auto-close sin mutar datos. Un worker puede usar esta función como contrato. */
export function evaluateAutoClose(
  db: Database,
  issueId: string,
  nowMs = Date.now(),
  workspaceId?: string,
): AutomationDecision {
  const issue = loadAutomationIssue(db, issueId, workspaceId);
  if (!issue) throw apiError("NOT_FOUND", "Issue not found");
  if (issue.auto_close_period == null) return { eligible: false, reason: "not_configured" };
  if (issue.archived_at || issue.team_archived_at) return { eligible: false, reason: "archived" };
  if (!isOpen(issue.state_type)) return { eligible: false, reason: "already_closed" };
  if (!dueAt(issue.updated_at, issue.auto_close_period, nowMs)) {
    return { eligible: false, reason: "recently_updated" };
  }
  const children = descendants(db, issue.id, workspaceId);
  if (hasActiveCycle(db, issue, children, workspaceId)) {
    return { eligible: false, reason: "active_cycle" };
  }
  if (hasUnfinishedProject(db, issue, children, workspaceId)) {
    return { eligible: false, reason: "unfinished_project" };
  }
  if (children.length > 0 && issue.auto_close_parent_issues === 0) {
    return { eligible: false, reason: "parent_issues_disabled" };
  }
  if (issue.parent_id && issue.auto_close_child_issues === 0) {
    return { eligible: false, reason: "child_issues_disabled" };
  }
  if (hasPendingChildren(children)) {
    return { eligible: false, reason: "pending_sub_issue" };
  }
  const targetStateId = targetCompletedState(db, issue, workspaceId);
  if (!targetStateId) return { eligible: false, reason: "missing_completed_state" };
  return { eligible: true, reason: "eligible", targetStateId };
}

/** Evalúa auto-archive sin mutar datos. Archive automático no es issueArchive manual. */
export function evaluateAutoArchive(
  db: Database,
  issueId: string,
  nowMs = Date.now(),
  workspaceId?: string,
): AutomationDecision {
  const issue = loadAutomationIssue(db, issueId, workspaceId);
  if (!issue) throw apiError("NOT_FOUND", "Issue not found");
  if (issue.auto_archive_period == null) return { eligible: false, reason: "not_configured" };
  if (issue.archived_at || issue.team_archived_at) return { eligible: false, reason: "archived" };
  if (isOpen(issue.state_type)) return { eligible: false, reason: "already_closed" };
  if (!dueAt(issue.updated_at, issue.auto_archive_period, nowMs)) {
    return { eligible: false, reason: "recently_updated" };
  }
  const children = descendants(db, issue.id, workspaceId);
  if (children.some((child) => child.archived_at || isOpen(child.state_type))) {
    return { eligible: false, reason: "pending_sub_issue" };
  }
  if (hasActiveCycle(db, issue, children, workspaceId)) {
    return { eligible: false, reason: "active_cycle" };
  }
  if (hasUnfinishedProject(db, issue, children, workspaceId)) {
    return { eligible: false, reason: "unfinished_project" };
  }
  return { eligible: true, reason: "eligible" };
}

/** Lista issues elegibles; no ejecuta cambios ni emite eventos. */
export function listAutomationCandidates(
  db: Database,
  teamId: string,
  nowMs = Date.now(),
  workspaceId?: string,
): {
  close: Array<{ issue: IssueRow; decision: AutomationDecision }>;
  archive: Array<{ issue: IssueRow; decision: AutomationDecision }>;
} {
  const workspace = workspaceId ? " AND workspace_id = ?2" : "";
  const rows = (
    workspaceId
      ? db.query(`SELECT id FROM issues WHERE team_id = ?1${workspace}`).all(teamId, workspaceId)
      : db.query("SELECT id FROM issues WHERE team_id = ?1").all(teamId)
  ) as Array<{ id: string }>;
  const close: Array<{ issue: IssueRow; decision: AutomationDecision }> = [];
  const archive: Array<{ issue: IssueRow; decision: AutomationDecision }> = [];
  for (const row of rows) {
    const issue = getIssue(db, row.id, workspaceId);
    if (!issue) continue;
    const closeDecision = evaluateAutoClose(db, issue.id, nowMs, workspaceId);
    if (closeDecision.eligible) close.push({ issue, decision: closeDecision });
    const archiveDecision = evaluateAutoArchive(db, issue.id, nowMs, workspaceId);
    if (archiveDecision.eligible) archive.push({ issue, decision: archiveDecision });
  }
  return { close, archive };
}

// Los imports de Persistence quedan fuera del runtime por ahora. Un
// worker futuro de PostgreSQL puede implementar el mismo contrato sin exponer una
// mutation pública ni fingir que la evaluación SQLite se ejecuta automáticamente.
export type AutomationPersistence = Persistence | PersistenceTransaction;
