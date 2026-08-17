import { Link } from "../router.tsx";
import { Icon } from "../components/icons.tsx";

interface TeamHomeProps {
  team: {
    key: string;
    name: string;
    projects: Array<{ id: string; name: string; state: string }>;
    cycles: Array<{ id: string; name: string; number: number; state: string }>;
  };
}

export function TeamHomeView({ team }: TeamHomeProps) {
  return (
    <div className="team-home-page">
      <div className="team-home-header">
        <span className="team-home-key">{team.key}</span>
        <h1>{team.name}</h1>
        <p>Team workspace</p>
      </div>
      <div className="team-home-actions">
        <Link to={`/team/${team.key}`} className="team-home-card">
          <Icon name="issues" />
          <span>
            <strong>Issues</strong>
            <small>View and filter team issues</small>
          </span>
        </Link>
        <Link to={`/board/${team.key}`} className="team-home-card">
          <Icon name="board" />
          <span>
            <strong>Board</strong>
            <small>See work by workflow state</small>
          </span>
        </Link>
        <Link to={`/triage/${team.key}`} className="team-home-card">
          <Icon name="filter" />
          <span>
            <strong>Triage</strong>
            <small>Review incoming issues</small>
          </span>
        </Link>
      </div>
      <div className="team-home-summary">
        <span>{team.projects.length} projects</span>
        <span>{team.cycles.length} cycles</span>
      </div>
    </div>
  );
}
