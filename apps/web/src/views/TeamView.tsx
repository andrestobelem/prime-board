// Vista de team: lista agrupada por estado (AT-145). El board llega en AT-146.
import { useQuery } from "../api.ts";
import { IssueList, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const TEAM_QUERY = `query($key: String, $filter: IssueFilter) {
  team(key: $key) { id key name }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} }
  }
}`;

export function TeamView({ teamKey, teamId }: { teamKey: string; teamId: string | null }) {
  const result = useQuery<{
    team: { id: string; key: string; name: string } | null;
    issues: { nodes: IssueListItem[] };
  }>(TEAM_QUERY, { key: teamKey, filter: teamId ? { team: { eq: teamId } } : {} });

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  if (!result.data?.team) return <div className="empty">Team {teamKey} not found.</div>;

  return <IssueList issues={result.data.issues.nodes} />;
}
