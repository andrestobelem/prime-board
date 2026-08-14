// Sidebar Linear-like: workspace y teams con sus proyectos anidados (AT-152).
import { Link, useRoute } from "../router.tsx";

interface SidebarProps {
  workspace: { name: string } | null;
  teams: Array<{
    id: string;
    key: string;
    name: string;
    projects: Array<{ id: string; name: string }>;
  }>;
}

export function Sidebar({ workspace, teams }: SidebarProps) {
  const route = useRoute();
  const active = (path: string) => (`/${route.join("/")}` === path ? "active" : "");
  return (
    <nav className="sidebar">
      <div className="workspace">
        <span className="logo">pb</span>
        {workspace?.name ?? "prime-board"}
      </div>
      {teams.map((team) => (
        <div key={team.id}>
          <div className="section">{team.name}</div>
          <Link to={`/team/${team.key}`} className={active(`/team/${team.key}`)}>
            <span style={{ color: "var(--text-faint)" }}>#</span> Issues
          </Link>
          {team.projects.map((project) => (
            <Link
              key={project.id}
              to={`/project/${project.id}`}
              className={active(`/project/${project.id}`)}
              // Anidado bajo el team, como en Linear.
            >
              <span style={{ color: "var(--text-faint)", paddingLeft: 10 }}>▦</span> {project.name}
            </Link>
          ))}
        </div>
      ))}
      <div className="spacer" />
      <div className="hint"><kbd>C</kbd> new issue · <kbd>⌘K</kbd> commands</div>
      <Link to="/members" className={active("/members")}>◉ Members</Link>
      <Link to="/settings" className={active("/settings")}>⚙ Settings</Link>
    </nav>
  );
}
