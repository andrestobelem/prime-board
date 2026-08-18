// Vista de team: lista agrupada por estado (AT-145). El board llega en AT-146.
import { useEffect, useMemo, useRef, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { IssueFilterToolbar } from "../components/IssueFilterToolbar.tsx";
import type { IssueActionInput, IssueActionOptions } from "../components/IssueActions.tsx";
import type { IssueColumn, IssueOrder } from "../components/DisplayOptions.tsx";
import { archiveMutation, issueUpdateMutation, runIssueActions } from "../issue-actions.ts";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import {
  buildIssueFilter,
  loadIssueFilter,
  saveIssueFilter,
  type IssueFilterDraft,
} from "../issue-filter.ts";

const TEAM_QUERY = `query($key: String, $teamId: ID, $filter: IssueFilter, $orderBy: IssueOrder) {
  team(key: $key) {
    id key name
    states { id name type color position }
    projects { id name milestones { id name } }
    cycles { id name number }
  }
  actors { id name type }
  labels(team: $teamId) { id name color }
  issues(filter: $filter, first: 250, orderBy: $orderBy) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage }
  }
}`;

interface TeamState {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

interface TeamData {
  team: {
    id: string;
    key: string;
    name: string;
    states: TeamState[];
    projects: Array<{ id: string; name: string; milestones: Array<{ id: string; name: string }> }>;
    cycles: Array<{ id: string; name: string; number: number }>;
  } | null;
  actors: Array<{ id: string; name: string; type: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  issues: { nodes: IssueListItem[]; pageInfo: { hasNextPage: boolean } };
}

export function TeamView({
  teamKey,
  teamId,
  groupBy = "state",
  triage = false,
  orderBy = "UPDATED_DESC",
  visibleColumns = ["priority", "labels", "assignee"] as IssueColumn[],
}: {
  teamKey: string;
  teamId: string | null;
  groupBy?: GroupBy;
  triage?: boolean;
  orderBy?: IssueOrder;
  visibleColumns?: IssueColumn[];
}) {
  const [draft, setDraft] = useState<IssueFilterDraft>(() => loadIssueFilter(teamKey));
  const draftTeamKey = useRef(teamKey);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  useEffect(() => {
    draftTeamKey.current = teamKey;
    setDraft(loadIssueFilter(teamKey));
    setSelectedIds(new Set());
  }, [teamKey]);

  useEffect(() => {
    if (draftTeamKey.current === teamKey) saveIssueFilter(teamKey, draft);
  }, [draft, teamKey]);

  const filter = useMemo(() => {
    const base = buildIssueFilter(teamId, draft);
    return triage ? { ...base, stateType: { eq: "TRIAGE" } } : base;
  }, [teamId, draft, triage]);
  const result = useQuery<TeamData>(TEAM_QUERY, { key: teamKey, teamId, filter, orderBy });
  const visibleIds = useMemo(
    () => result.data?.issues.nodes.map((issue) => issue.id) ?? [],
    [result.data?.issues.nodes],
  );

  useEffect(() => {
    const visible = new Set(visibleIds);
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

  const actionOptions: IssueActionOptions = {
    states: result.data?.team?.states ?? [],
    actors: result.data?.actors ?? [],
    labels: result.data?.labels ?? [],
    projects: result.data?.team?.projects ?? [],
    cycles: result.data?.team?.cycles ?? [],
  };

  async function bulkAction(input: IssueActionInput): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkLoading(true);
    setBulkError(null);
    try {
      await runIssueActions(ids, async (id) => {
        const response = await mutate<{ issueUpdate: { success: boolean } }>(
          issueUpdateMutation(),
          { id, input },
        );
        return response.issueUpdate;
      });
      setSelectedIds(new Set());
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Could not update selected issues.");
    } finally {
      setBulkLoading(false);
    }
  }

  async function bulkArchive(): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkLoading(true);
    setBulkError(null);
    try {
      await runIssueActions(ids, async (id) => {
        const response = await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), {
          id,
        });
        return response.issueArchive;
      });
      setSelectedIds(new Set());
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Could not archive selected issues.");
    } finally {
      setBulkLoading(false);
    }
  }

  async function updateIssue(id: string, input: IssueActionInput): Promise<void> {
    const response = await mutate<{ issueUpdate: { success: boolean } }>(issueUpdateMutation(), {
      id,
      input,
    });
    if (!response.issueUpdate.success) throw new Error(`Could not update issue ${id}.`);
  }

  async function archiveIssue(id: string): Promise<void> {
    const response = await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), {
      id,
    });
    if (!response.issueArchive.success) throw new Error(`Could not archive issue ${id}.`);
  }

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  if (!result.data?.team) return <div className="empty">Team {teamKey} not found.</div>;

  const issues = result.data.issues.nodes;
  return (
    <>
      <IssueFilterToolbar
        draft={draft}
        states={result.data.team.states}
        actors={result.data.actors}
        labels={result.data.labels}
        projects={result.data.team.projects}
        milestones={result.data.team.projects.flatMap((project) => project.milestones)}
        cycles={result.data.team.cycles}
        parents={issues.flatMap((issue) =>
          issue.parent
            ? [{ id: issue.parent.id, name: `${issue.parent.identifier} ${issue.parent.title}` }]
            : [],
        )}
        visibleCount={issues.length}
        selectedCount={selectedIds.size}
        onChange={setDraft}
        onSelectAll={() =>
          setSelectedIds((current) =>
            current.size === issues.length ? new Set() : new Set(issues.map((issue) => issue.id)),
          )
        }
        onClearSelection={() => setSelectedIds(new Set())}
        onBulkState={(stateId) => bulkAction({ stateId })}
        actionOptions={actionOptions}
        onBulkAction={bulkAction}
        onBulkArchive={bulkArchive}
        bulkLoading={bulkLoading}
      />
      {bulkError && <div className="error-banner">{bulkError}</div>}
      <IssueListLimitNotice hasNextPage={result.data.issues.pageInfo.hasNextPage} />
      <IssueList
        issues={issues}
        groupBy={groupBy}
        selection={{
          selectedIds,
          onToggle: (id) =>
            setSelectedIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            }),
          onSelectAll: () => setSelectedIds(new Set(issues.map((issue) => issue.id))),
          onClear: () => setSelectedIds(new Set()),
        }}
        actionOptions={actionOptions}
        visibleColumns={visibleColumns}
        onIssueAction={updateIssue}
        onArchiveIssue={archiveIssue}
      />
    </>
  );
}
