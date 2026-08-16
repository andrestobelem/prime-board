// Vista de team: lista agrupada por estado (AT-145). El board llega en AT-146.
import { useEffect, useMemo, useRef, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { IssueFilterToolbar } from "../components/IssueFilterToolbar.tsx";
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

const TEAM_QUERY = `query($key: String, $teamId: ID, $filter: IssueFilter) {
  team(key: $key) {
    id key name
    states { id name type color position }
  }
  actors { id name type }
  labels(team: $teamId) { id name color }
  issues(filter: $filter, first: 250) {
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
  team: { id: string; key: string; name: string; states: TeamState[] } | null;
  actors: Array<{ id: string; name: string; type: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  issues: { nodes: IssueListItem[]; pageInfo: { hasNextPage: boolean } };
}

export function TeamView({
  teamKey,
  teamId,
  groupBy = "state",
  triage = false,
}: {
  teamKey: string;
  teamId: string | null;
  groupBy?: GroupBy;
  triage?: boolean;
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
  const result = useQuery<TeamData>(TEAM_QUERY, { key: teamKey, teamId, filter });
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

  async function bulkUpdateState(stateId: string): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkLoading(true);
    setBulkError(null);
    try {
      for (const id of ids) {
        const response = await mutate<{ issueUpdate: { success: boolean } }>(
          `mutation($id: ID!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }`,
          { id, input: { stateId } },
        );
        if (!response.issueUpdate.success) throw new Error("An issue could not be updated.");
      }
      setSelectedIds(new Set());
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Could not update selected issues.");
    } finally {
      setBulkLoading(false);
    }
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
        visibleCount={issues.length}
        selectedCount={selectedIds.size}
        onChange={setDraft}
        onSelectAll={() =>
          setSelectedIds((current) =>
            current.size === issues.length ? new Set() : new Set(issues.map((issue) => issue.id)),
          )
        }
        onClearSelection={() => setSelectedIds(new Set())}
        onBulkState={bulkUpdateState}
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
        }}
      />
    </>
  );
}
