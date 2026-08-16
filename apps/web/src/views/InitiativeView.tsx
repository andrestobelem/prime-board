// Iniciativa (PRB-206): agrupa proyectos relacionados.
import { useState } from "react";
import { GqlError, mutate, useQuery } from "../api.ts";
import { Link } from "../router.tsx";
import { Icon } from "../components/icons.tsx";
import { EntityModal } from "../components/EntityModal.tsx";

const QUERY = `query($id: ID!) {
  initiative(id: $id) {
    id name description state targetDate progress completedIssues totalIssues
    projects { id name state }
  }
  projects { id name state }
}`;

export function InitiativeView({ initiativeId }: { initiativeId: string }) {
  const result = useQuery<{
    initiative: {
      id: string;
      name: string;
      description: string | null;
      state: string;
      targetDate: string | null;
      progress: number;
      completedIssues: number;
      totalIssues: number;
      projects: Array<{ id: string; name: string; state: string }>;
    } | null;
    projects: Array<{ id: string; name: string; state: string }>;
  }>(QUERY, { id: initiativeId });
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  async function addProject(values: Record<string, string>) {
    const initiative = result.data?.initiative;
    if (!initiative) return;
    if (!values.projectId) throw new Error("Project is required");
    setError(null);
    await mutate(
      `mutation($id: ID!, $projectIds: [ID!]!) {
      initiativeUpdate(id: $id, input: { projectIds: $projectIds }) {
        initiative { id }
      }
    }`,
      {
        id: initiative.id,
        projectIds: [...initiative.projects.map((p) => p.id), values.projectId],
      },
    );
    setLinkOpen(false);
  }

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  const initiative = result.data?.initiative;
  if (!initiative) return <div className="empty">Initiative not found.</div>;

  return (
    <div>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 15 }}>{initiative.name}</strong>
        <span className="label-chip">{initiative.state.toLowerCase()}</span>
        {initiative.targetDate && (
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            target {initiative.targetDate.slice(0, 10)}
          </span>
        )}
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          {initiative.completedIssues}/{initiative.totalIssues}(
          {Math.round(initiative.progress * 100)}%)
        </span>
        <button
          className="btn secondary"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            const available = (result.data?.projects ?? []).filter(
              (project) => !initiative.projects.some((linked) => linked.id === project.id),
            );
            if (available.length === 0) setError("No projects available to link");
            else setLinkOpen(true);
          }}
        >
          Link project
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {initiative.description && (
        <p style={{ padding: "12px 16px", color: "var(--text-muted)", margin: 0 }}>
          {initiative.description}
        </p>
      )}
      <div className="section" style={{ padding: "8px 16px" }}>
        Projects
      </div>
      {initiative.projects.length === 0 ? (
        <div className="empty">No projects linked.</div>
      ) : (
        initiative.projects.map((project) => (
          <Link
            key={project.id}
            to={`/project/${project.id}`}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <Icon name="project" />
            <span>{project.name}</span>
            <span className="label-chip" style={{ marginLeft: "auto" }}>
              {project.state.toLowerCase()}
            </span>
          </Link>
        ))
      )}
      {linkOpen && (
        <EntityModal
          title="Link project"
          submitLabel="Link project"
          fields={[
            {
              key: "projectId",
              label: "Project",
              type: "select",
              options: (result.data?.projects ?? [])
                .filter(
                  (project) => !initiative.projects.some((linked) => linked.id === project.id),
                )
                .map((project) => ({ value: project.id, label: project.name })),
            },
          ]}
          onClose={() => setLinkOpen(false)}
          onSubmit={addProject}
        />
      )}
    </div>
  );
}
