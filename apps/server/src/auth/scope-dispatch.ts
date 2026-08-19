// Despacho central de capacidades de API keys y allowlists de Teams (PRB-380).
import type { Context } from "../graphql/context.ts";
import { apiError } from "../graphql/errors.ts";
import {
  assertApiKeyScope,
  assertApiKeyTeams,
  assertUnrestrictedApiKey,
  hasApiKeyTeamLimit,
  apiKeyTeamsWithinLimit,
} from "./permissions.ts";
import type { ApiKeyScope } from "../domain/actors.ts";
import { getIssueByRef } from "../domain/issues.ts";

const ADMIN_MUTATIONS = new Set([
  "workspaceUpdate",
  "teamArchive",
  "teamUnarchive",
  "teamDelete",
  "teamCreate",
  "actorCreate",
  "actorInvite",
  "actorInvitationRevoke",
  "actorSuspend",
  "actorReactivate",
  "actorRevoke",
]);

const KEY_MUTATIONS = new Set(["apiKeyCreate", "apiKeyDelete", "apiKeyRotate"]);
const SAFE_MUTATIONS = new Set(["actorUpdate", "actorLeave", ...KEY_MUTATIONS]);

// PRB-430/431 migran primero Workspace, actores y credenciales. Las demás
// operaciones no deben caer silenciosamente en el SQLite efímero del seam.
const POSTGRES_SUPPORTED_OPERATIONS = new Set([
  "query:viewer",
  "query:workspace",
  "query:actors",
  "query:teams",
  "query:team",
  "query:teamMemberships",
  "query:issue",
  "query:issues",
  "query:labels",
  "query:actorInvitations",
  "mutation:workspaceUpdate",
  "mutation:teamArchive",
  "mutation:teamUnarchive",
  "mutation:teamDelete",
  "mutation:teamCreate",
  "mutation:teamUpdate",
  "mutation:teamMembershipCreate",
  "mutation:teamMembershipDelete",
  "mutation:workflowStateCreate",
  "mutation:workflowStateUpdate",
  "mutation:workflowStateDelete",
  "mutation:actorCreate",
  "mutation:actorUpdate",
  "mutation:actorInvite",
  "mutation:actorInvitationAccept",
  "mutation:actorInvitationRevoke",
  "mutation:actorSuspend",
  "mutation:actorReactivate",
  "mutation:actorRevoke",
  "mutation:actorLeave",
  "mutation:issueCreate",
  "mutation:issueUpdate",
  "mutation:issueArchive",
  "mutation:labelCreate",
  "mutation:labelUpdate",
  "mutation:labelDelete",
  "mutation:issueRelationCreate",
  "mutation:issueRelationDelete",
  "mutation:apiKeyCreate",
  "mutation:apiKeyDelete",
  "mutation:apiKeyRotate",
]);

type Resolver = (...args: any[]) => any;
type ResolverMap = Record<string, Resolver>;

function scalar(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function teamForRef(context: Context, ref: unknown): string | null {
  const value = scalar(ref);
  if (!value) return null;
  const row = context.db.query("SELECT id FROM teams WHERE id = ?1 OR key = ?1").get(value) as {
    id: string;
  } | null;
  return row?.id ?? null;
}

function teamIdsForIssue(context: Context, issueId: unknown): string[] {
  const id = scalar(issueId);
  if (!id) return [];
  const row = getIssueByRef(context.db, id);
  return row ? [row.team_id] : [];
}

function teamIdsForProject(context: Context, projectId: unknown): string[] {
  const id = scalar(projectId);
  if (!id) return [];
  return context.db
    .query("SELECT team_id FROM project_teams WHERE project_id = ?1 ORDER BY team_id")
    .all(id)
    .map((row) => (row as { team_id: string }).team_id);
}

function teamIdsForMilestone(context: Context, milestoneId: unknown): string[] {
  const id = scalar(milestoneId);
  if (!id) return [];
  const row = context.db.query("SELECT project_id FROM milestones WHERE id = ?1").get(id) as {
    project_id: string;
  } | null;
  return row ? teamIdsForProject(context, row.project_id) : [];
}

function teamIdsForCycle(context: Context, cycleId: unknown): string[] {
  const id = scalar(cycleId);
  if (!id) return [];
  const row = context.db.query("SELECT team_id FROM cycles WHERE id = ?1").get(id) as {
    team_id: string;
  } | null;
  return row ? [row.team_id] : [];
}

function teamIdsForReview(context: Context, reviewId: unknown): string[] {
  const id = scalar(reviewId);
  if (!id) return [];
  const row = context.db.query("SELECT issue_id FROM reviews WHERE id = ?1").get(id) as {
    issue_id: string;
  } | null;
  return row ? teamIdsForIssue(context, row.issue_id) : [];
}

function teamIdsForSavedView(context: Context, viewId: unknown): string[] {
  const id = scalar(viewId);
  if (!id) return ["__missing__"];
  const row = context.db.query("SELECT team_id FROM saved_views WHERE id = ?1").get(id) as {
    team_id: string | null;
  } | null;
  if (!row) return ["__missing__"];
  return row.team_id ? [row.team_id] : ["__workspace__"];
}

function teamIdsForInitiative(context: Context, initiativeId: unknown): string[] {
  const id = scalar(initiativeId);
  if (!id) return ["__missing__"];
  if (!context.db.query("SELECT id FROM initiatives WHERE id = ?1").get(id)) return ["__missing__"];
  const direct = context.db
    .query("SELECT team_id FROM initiative_teams WHERE initiative_id = ?1")
    .all(id)
    .map((row) => (row as { team_id: string }).team_id);
  const projects = context.db
    .query("SELECT project_id FROM initiative_projects WHERE initiative_id = ?1")
    .all(id)
    .flatMap((row) => teamIdsForProject(context, (row as { project_id: string }).project_id));
  const teams = [...new Set([...direct, ...projects])].sort();
  return teams.length ? teams : ["__workspace__"];
}

function teamIdsForFavorite(context: Context, favoriteId: unknown): string[] {
  const id = scalar(favoriteId);
  if (!id) return [];
  const row = context.db
    .query("SELECT project_id, saved_view_id FROM favorites WHERE id = ?1")
    .get(id) as { project_id: string | null; saved_view_id: string | null } | null;
  if (!row) return [];
  return row.project_id
    ? teamIdsForProject(context, row.project_id)
    : teamIdsForSavedView(context, row.saved_view_id);
}

function teamIdsForInbox(context: Context, itemId: unknown): string[] {
  const id = scalar(itemId);
  if (!id) return [];
  const row = context.db
    .query(
      "SELECT activity.issue_id FROM inbox_receipts JOIN activity ON activity.id = inbox_receipts.activity_id WHERE inbox_receipts.activity_id = ?1 OR inbox_receipts.rowid = ?1",
    )
    .get(id) as { issue_id: string } | null;
  return row ? teamIdsForIssue(context, row.issue_id) : [];
}

function issueFilterTeams(context: Context, filter: unknown): string[] | null {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
  const object = filter as Record<string, unknown>;
  const teams = object.team as Record<string, unknown> | undefined;
  if (teams) {
    const direct = scalar(teams.eq);
    if (direct) return [teamForRef(context, direct) ?? "__missing__"];
    const list = ids(teams.in);
    if (list.length) return list.map((team) => teamForRef(context, team) ?? "__missing__");
  }
  const nested = [...ids(object.and), ...ids(object.or)];
  void nested;
  // A broad OR/AND filter without a Team predicate is intentionally denied for
  // limited keys rather than risking a cross-Team result set.
  return null;
}

function operationTeamIds(
  context: Context,
  field: string,
  args: Record<string, unknown>,
): string[] | null {
  const input = (args.input && typeof args.input === "object" ? args.input : {}) as Record<
    string,
    unknown
  >;
  const directTeam = teamForRef(context, args.teamId ?? input.teamId ?? args.team ?? input.team);
  if (directTeam) return [directTeam];

  switch (field) {
    case "viewer":
    case "workspace":
    case "teams":
      return [];
    case "team":
      // PostgreSQL team lookup happens asynchronously in the resolver; it
      // applies the key allowlist after resolving the Team.
      if (context.persistence) return [];
      return [teamForRef(context, args.id ?? args.key) ?? "__missing__"];
    case "teamMemberships":
    case "cycles":
      return [scalar(args.teamId) ?? "__missing__"];
    case "cycle":
      return teamIdsForCycle(context, args.id);
    case "issue":
      if (context.persistence) return [];
      return teamIdsForIssue(context, args.id);
    case "issues":
      if (context.persistence) return [];
      return issueFilterTeams(context, args.filter);
    case "project":
      return teamIdsForProject(context, args.id);
    case "projects":
      return args.team ? [teamForRef(context, args.team) ?? "__missing__"] : null;
    case "labels":
      if (context.persistence) return [];
      return args.team ? [teamForRef(context, args.team) ?? "__missing__"] : null;
    case "savedView":
      return teamIdsForSavedView(context, args.id);
    case "savedViews":
      return args.teamId ? [scalar(args.teamId) ?? "__missing__"] : null;
    case "review":
      return teamIdsForReview(context, args.id);
    case "reviews":
      if (args.teamId) return [scalar(args.teamId) ?? "__missing__"];
      if (args.projectId) return teamIdsForProject(context, args.projectId);
      return null;
    case "initiative":
      return teamIdsForInitiative(context, args.id);
    case "initiatives":
    case "webhooks":
    case "favorites":
    case "inbox":
    case "inboxPage":
    case "inboxUnreadCount":
      // Son colecciones de Workspace sin selector Team; una key limitada no
      // puede recibir un resultado global ni inferir un filtro seguro.
      return null;
    case "actors":
      // La identidad del actor tiene alcance de Workspace y apiKeys solo expone
      // las keys propias al actor no administrador.
      return [];
    case "teamUpdate":
    case "teamArchive":
    case "teamUnarchive":
    case "teamDelete":
      return [scalar(args.id) ?? "__missing__"];
    case "teamMembershipCreate":
      return [scalar(input.teamId) ?? "__missing__"];
    case "teamMembershipDelete":
      if (context.persistence) return [];
      return context.db
        .query("SELECT team_id FROM team_memberships WHERE id = ?1")
        .all(scalar(args.id))
        .map((row) => (row as { team_id: string }).team_id);
    case "workflowStateCreate":
      return [scalar(input.teamId) ?? "__missing__"];
    case "workflowStateUpdate":
    case "workflowStateDelete": {
      if (context.persistence) return [];
      const row = context.db
        .query("SELECT team_id FROM workflow_states WHERE id = ?1")
        .get(scalar(args.id)) as { team_id: string } | null;
      return row ? [row.team_id] : ["__missing__"];
    }
    case "labelCreate":
      return input.teamId ? [scalar(input.teamId) ?? "__missing__"] : null;
    case "labelUpdate":
    case "labelDelete": {
      const row = context.db
        .query("SELECT team_id FROM labels WHERE id = ?1")
        .get(scalar(args.id)) as { team_id: string | null } | null;
      return row?.team_id ? [row.team_id] : null;
    }
    case "issueCreate": {
      if (context.persistence) return [];
      const direct = input.teamId ?? input.teamKey;
      return [
        ...(direct ? [teamForRef(context, direct) ?? "__missing__"] : []),
        ...(input.projectId ? teamIdsForProject(context, input.projectId) : []),
      ];
    }
    case "issueUpdate": {
      if (context.persistence) return [];
      const current = teamIdsForIssue(context, args.id);
      const target = input.projectId ? teamIdsForProject(context, input.projectId) : [];
      const parent = input.parentId ? teamIdsForIssue(context, input.parentId) : [];
      const cycle = input.cycleId ? teamIdsForCycle(context, input.cycleId) : [];
      const milestone = input.milestoneId ? teamIdsForMilestone(context, input.milestoneId) : [];
      return [...new Set([...current, ...target, ...parent, ...cycle, ...milestone])];
    }
    case "issueArchive":
      if (context.persistence) return [];
      return teamIdsForIssue(context, args.id);
    case "commentCreate":
      return teamIdsForIssue(context, input.issueId);
    case "issueRelationCreate":
      if (context.persistence) return [];
      return [
        ...new Set([
          ...teamIdsForIssue(context, input.issueId),
          ...teamIdsForIssue(context, input.relatedIssueId),
        ]),
      ];
    case "issueRelationDelete": {
      if (context.persistence) return [];
      const row = context.db
        .query("SELECT issue_id, related_id FROM issue_relations WHERE id = ?1")
        .get(scalar(args.id)) as { issue_id: string; related_id: string } | null;
      return row
        ? [
            ...new Set([
              ...teamIdsForIssue(context, row.issue_id),
              ...teamIdsForIssue(context, row.related_id),
            ]),
          ]
        : ["__missing__"];
    }
    case "projectCreate":
      return input.teamIds == null
        ? context.db
            .query("SELECT id FROM teams WHERE archived_at IS NULL ORDER BY id")
            .all()
            .map((row) => (row as { id: string }).id)
        : ids(input.teamIds);
    case "projectUpdate": {
      const current = teamIdsForProject(context, args.id);
      return input.teamIds === undefined
        ? current
        : [...new Set([...current, ...ids(input.teamIds)])];
    }
    case "projectArchive":
    case "projectUnarchive":
      return teamIdsForProject(context, args.id);
    case "milestoneCreate":
      return teamIdsForProject(context, input.projectId);
    case "milestoneUpdate":
    case "milestoneDelete":
      return teamIdsForMilestone(context, args.id);
    case "projectUpdateCreate":
      return teamIdsForProject(context, input.projectId);
    case "projectUpdateDelete": {
      const row = context.db
        .query("SELECT project_id FROM project_updates WHERE id = ?1")
        .get(scalar(args.id)) as { project_id: string } | null;
      return row ? teamIdsForProject(context, row.project_id) : ["__missing__"];
    }
    case "cycleCreate":
      return [scalar(input.teamId) ?? "__missing__"];
    case "cycleUpdate":
    case "cycleDelete":
      return teamIdsForCycle(context, args.id);
    case "cycleCarryOver":
      return [
        ...new Set([
          ...teamIdsForCycle(context, args.fromCycleId),
          ...teamIdsForCycle(context, args.toCycleId),
        ]),
      ];
    case "reviewCreate":
      return teamIdsForIssue(context, input.issueId);
    case "reviewUpdate":
    case "reviewDelete":
      return teamIdsForReview(context, args.id);
    case "savedViewCreate":
      return input.scope?.toString().toLowerCase() === "team"
        ? [scalar(input.teamId) ?? "__missing__"]
        : null;
    case "savedViewUpdate":
    case "savedViewDuplicate":
    case "savedViewDelete":
      return teamIdsForSavedView(context, args.id);
    case "favoriteCreate":
      return input.projectId
        ? teamIdsForProject(context, input.projectId)
        : teamIdsForSavedView(context, input.savedViewId);
    case "favoriteDelete":
    case "favoriteReorder":
      return teamIdsForFavorite(context, args.id);
    case "initiativeCreate": {
      const teams = [
        ...new Set([
          ...ids(input.teamIds),
          ...ids(input.projectIds).flatMap((id) => teamIdsForProject(context, id)),
        ]),
      ];
      return teams.length ? teams : ["__workspace__"];
    }
    case "initiativeUpdate": {
      const current = teamIdsForInitiative(context, args.id);
      const direct =
        input.teamIds !== undefined && input.teamIds !== null ? ids(input.teamIds) : current;
      const projects =
        input.projectIds !== undefined && input.projectIds !== null
          ? ids(input.projectIds).flatMap((id) => teamIdsForProject(context, id))
          : [];
      const teams = [...new Set([...direct, ...projects])];
      return teams.length ? teams : ["__workspace__"];
    }
    case "initiativeDelete":
      return teamIdsForInitiative(context, args.id);
    case "inboxMarkRead":
    case "inboxArchive":
      return teamIdsForInbox(context, args.id);
    default:
      return null;
  }
}

function assertOperationTeams(
  context: Context,
  field: string,
  args: Record<string, unknown>,
  kind: "query" | "mutation",
): void {
  if (!hasApiKeyTeamLimit(context.auth)) return;
  if (kind === "mutation" && SAFE_MUTATIONS.has(field)) return;
  const teamIds = operationTeamIds(context, field, args);
  if (teamIds === null) {
    throw apiError(
      "UNAUTHORIZED",
      "A Team-limited API key cannot access an unrestricted operation",
    );
  }
  assertApiKeyTeams(context, teamIds);
}

function wrapResolverMap(map: ResolverMap, kind: "query" | "mutation"): ResolverMap {
  return Object.fromEntries(
    Object.entries(map).map(([field, resolver]) => [
      field,
      (...args: unknown[]) => {
        const context = args[2] as Context;
        const resolverArgs = (args[1] ?? {}) as Record<string, unknown>;
        if (context.persistence && !POSTGRES_SUPPORTED_OPERATIONS.has(`${kind}:${field}`)) {
          throw apiError("VALIDATION_FAILED", "This operation is not migrated to PostgreSQL yet");
        }
        if (kind === "mutation" && field === "actorInvitationAccept") return resolver(...args);
        if (kind === "mutation" && ADMIN_MUTATIONS.has(field)) {
          assertApiKeyScope(context, "admin");
          assertUnrestrictedApiKey(context);
        } else {
          assertApiKeyScope(context, kind === "query" ? "read" : "write");
        }
        if (!KEY_MUTATIONS.has(field)) assertOperationTeams(context, field, resolverArgs, kind);
        const result = resolver(...args);
        const filterAsync = (value: unknown, filter: (items: unknown[]) => unknown[]): unknown => {
          if (Array.isArray(value)) return filter(value);
          if (value && typeof (value as Promise<unknown>).then === "function") {
            return (value as Promise<unknown>).then((resolved) =>
              Array.isArray(resolved) ? filter(resolved) : resolved,
            );
          }
          return value;
        };
        if (kind === "query" && field === "teams" && context.auth?.teamIds) {
          const allowed = new Set(context.auth.teamIds);
          return filterAsync(result, (items) =>
            items.filter((team) => {
              const row = (team as { id?: string }).id;
              return row ? allowed.has(row) : false;
            }),
          );
        }
        // Un proyecto puede abarcar varios Teams. Seleccionar un Team permitido no alcanza:
        // ocultamos el proyecto salvo que todos sus Teams estén permitidos.
        if (kind === "query" && field === "projects" && context.auth?.teamIds) {
          return filterAsync(result, (items) =>
            items.filter((project) => {
              const id = (project as { id?: string }).id;
              return id
                ? apiKeyTeamsWithinLimit(context.auth, teamIdsForProject(context, id))
                : false;
            }),
          );
        }
        return result;
      },
    ]),
  );
}

export function withApiKeyScopes(map: ResolverMap, kind: "query" | "mutation"): ResolverMap {
  return wrapResolverMap(map, kind);
}
