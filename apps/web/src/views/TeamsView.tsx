import { Link } from "../router.tsx";
import { Icon } from "../components/icons.tsx";

export interface TeamSummary {
  id: string;
  key: string;
  name: string;
  projects: Array<{ id: string; name: string; state: string }>;
  cycles?: Array<{ id: string; name: string; number: number; state: string }>;
}

export function TeamsView({ teams }: { teams: TeamSummary[] }) {
  if (!teams.length) return <div className="empty">No teams yet.</div>;
  return (
    <div className="teams-page">
      <h1>Teams</h1>
      <p className="teams-intro">Teams organize issues, projects, cycles, and workflow.</p>
      <div className="team-cards">
        {teams.map((team) => (
          <Link key={team.id} to={`/team/${team.key}`} className="team-card">
            <span className="team-card-icon">
              <Icon name="issues" />
            </span>
            <span className="team-card-body">
              <strong>{team.name}</strong>
              <span>
                {team.key} · {team.projects.length} projects · {(team.cycles ?? []).length} cycles
              </span>
            </span>
            <Icon name="chevron-right" size={14} />
          </Link>
        ))}
      </div>
    </div>
  );
}
