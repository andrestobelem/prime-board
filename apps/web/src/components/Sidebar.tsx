// Sidebar Linear-like: workspace, teams, proyectos y settings.
import { Link, useRoute } from "../router.tsx";

interface SidebarProps {
  workspace: { name: string } | null;
  teams: Array<{ id: string; key: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
}

export function Sidebar({ workspace, teams, projects }: SidebarProps) {
  const route = useRoute();
  const active = (path: string) => (`/${route.join("/")}` === path ? "active" : "");
  return (
    <nav className="sidebar">
      <div className="workspace">
        <span className="logo">pb</span>
        {workspace?.name ?? "prime-board"}
      </div>
      <div className="section">Teams</div>
      {teams.map((team) => (
        <Link key={team.id} to={`/team/${team.key}`} className={active(`/team/${team.key}`)}>
          <span style={{ color: "var(--text-faint)" }}>#</span> {team.name}
        </Link>
      ))}
      <div className="section">Projects</div>
      {projects.map((project) => (
        <Link key={project.id} to={`/project/${project.id}`} className={active(`/project/${project.id}`)}>
          <span style={{ color: "var(--text-faint)" }}>▦</span> {project.name}
        </Link>
      ))}
      <div className="spacer" />
      <div className="hint"><kbd>C</kbd> new issue · <kbd>⌘K</kbd> commands</div>
      <Link to="/members" className={active("/members")}>◉ Members</Link>
      <Link to="/settings" className={active("/settings")}>⚙ Settings</Link>
    </nav>
  );
}
