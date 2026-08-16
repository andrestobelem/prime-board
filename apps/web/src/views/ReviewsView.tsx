// Cola de reviews (PRB-205/217): filtros team/proyecto/agente/edad.
import { useState } from "react";
import { GqlError, mutate, useQuery } from "../api.ts";
import { Avatar } from "../components/bits.tsx";
import { Link } from "../router.tsx";

interface ReviewItem {
  id: string;
  status: string;
  createdAt: string;
  requester: { id: string; name: string; type: string };
  reviewer: { id: string; name: string; type: string };
  issue: { identifier: string; title: string };
}

const STATUS_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "IN_PROGRESS", label: "In progress" },
  { status: "APPROVED", label: "Approve" },
  { status: "REJECTED", label: "Reject" },
  { status: "REQUESTED", label: "Re-request" },
];

export function ReviewsView() {
  const [openOnly, setOpenOnly] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [olderThanDays, setOlderThanDays] = useState("");
  const [error, setError] = useState<string | null>(null);

  const meta = useQuery<{
    actors: Array<{ id: string; name: string; type: string }>;
    teams: Array<{ id: string; key: string; name: string }>;
    projects: Array<{ id: string; name: string }>;
  }>(`{
    actors { id name type }
    teams { id key name }
    projects { id name }
  }`);

  const filterVars: Record<string, unknown> = {
    openOnly,
    first: 50,
  };
  if (teamId) filterVars.teamId = teamId;
  if (projectId) filterVars.projectId = projectId;
  if (reviewerId) filterVars.reviewerId = reviewerId;
  if (olderThanDays.trim() && Number(olderThanDays) > 0) {
    filterVars.olderThanDays = Number(olderThanDays);
  }

  const result = useQuery<{ reviews: ReviewItem[] }>(
    `query(
      $openOnly: Boolean, $first: Int,
      $teamId: ID, $projectId: ID, $reviewerId: ID, $olderThanDays: Int
    ) {
      reviews(
        openOnly: $openOnly, first: $first,
        teamId: $teamId, projectId: $projectId,
        reviewerId: $reviewerId, olderThanDays: $olderThanDays
      ) {
        id status createdAt
        requester { id name type }
        reviewer { id name type }
        issue { identifier title }
      }
    }`,
    filterVars,
  );

  async function setStatus(id: string, status: string) {
    setError(null);
    try {
      await mutate(
        `mutation($id: ID!, $status: ReviewStatus!) {
        reviewUpdate(id: $id, input: { status: $status }) { review { id status } }
      }`,
        { id, status },
      );
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
    }
  }

  async function requestReview() {
    const issueRef = window.prompt("Issue identifier (e.g. PRB-1)");
    if (!issueRef?.trim()) return;
    const actors = meta.data?.actors ?? [];
    const names = actors.map((a) => a.name).join(", ");
    const reviewerName = window.prompt(`Reviewer name (${names})`);
    if (!reviewerName?.trim()) return;
    const reviewer = actors.find((a) => a.name.toLowerCase() === reviewerName.trim().toLowerCase());
    if (!reviewer) {
      setError(`Unknown reviewer: ${reviewerName}`);
      return;
    }
    setError(null);
    try {
      await mutate(
        `mutation($input: ReviewCreateInput!) {
        reviewCreate(input: $input) { review { id } }
      }`,
        { input: { issueId: issueRef.trim(), reviewerId: reviewer.id } },
      );
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
    }
  }

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;

  const items = result.data?.reviews ?? [];
  const selectStyle = { fontSize: 12, maxWidth: 160 } as const;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(event) => setOpenOnly(event.target.checked)}
          />
          Open only
        </label>
        <select
          style={selectStyle}
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
        >
          <option value="">All teams</option>
          {(meta.data?.teams ?? []).map((team) => (
            <option key={team.id} value={team.id}>
              {team.key}
            </option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All projects</option>
          {(meta.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          style={selectStyle}
          value={reviewerId}
          onChange={(event) => setReviewerId(event.target.value)}
        >
          <option value="">All reviewers</option>
          {(meta.data?.actors ?? []).map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
        <input
          style={{ ...selectStyle, width: 72 }}
          type="number"
          min={1}
          placeholder="Age days"
          value={olderThanDays}
          onChange={(event) => setOlderThanDays(event.target.value)}
          title="Older than N days"
        />
        <span style={{ color: "var(--text-muted)", fontSize: 13, flex: 1 }}>
          Reviews where you are requester or reviewer
        </span>
        <button className="btn" onClick={() => void requestReview()}>
          Request review
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {items.length === 0 ? (
        <div className="empty">No reviews yet.</div>
      ) : (
        items.map((review) => (
          <div
            key={review.id}
            className="comment"
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <Avatar actor={review.reviewer} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>
                <strong>{review.requester.name}</strong>{" "}
                <span style={{ color: "var(--text-muted)" }}>asked</span>{" "}
                <strong>{review.reviewer.name}</strong>{" "}
                <span className="label-chip">{review.status.toLowerCase().replace("_", " ")}</span>
              </div>
              <Link to={`/issue/${review.issue.identifier}`} style={{ fontSize: 13 }}>
                <code style={{ color: "var(--accent)" }}>{review.issue.identifier}</code>{" "}
                {review.issue.title}
              </Link>
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_ACTIONS.filter((action) => action.status !== review.status).map(
                  (action) => (
                    <button
                      key={action.status}
                      className="btn secondary"
                      style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => void setStatus(review.id, action.status)}
                    >
                      {action.label}
                    </button>
                  ),
                )}
              </div>
            </div>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {review.createdAt.slice(0, 10)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
