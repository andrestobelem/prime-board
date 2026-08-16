// Sidebar Linear-like: workspace y teams con sus proyectos anidados (AT-152).
import { useState } from "react";
import { Link, useRoute } from "../router.tsx";
import { Icon } from "./icons.tsx";

interface SidebarProps {
  workspace: { name: string } | null;
  teams: Array<{
    id: string;
    key: string;
    name: string;
    projects: Array<{ id: string; name: string; state: string }>;
  }>;
}

const CLOSED_STATES = ["COMPLETED", "CANCELED"];

export function Sidebar({ workspace, teams }: SidebarProps) {
  const route = useRoute();
  // Los proyectos cerrados se colapsan para no saturar el sidebar (AT-30).
  const [showClosed, setShowClosed] = useState<Record<string, boolean>>({});
  const active = (path: string) => (`/${route.join("/")}` === path ? "active" : "");
  return (
    <nav className="sidebar">
      <div className="workspace">
        <Icon name="workspace" size={18} className="logo" />
        {workspace?.name ?? "prime-board"}
      </div>
      {teams.map((team) => (
        <div key={team.id}>
          <div className="section">{team.name}</div>
          <Link to={`/team/${team.key}`} className={active(`/team/${team.key}`)}>
            <Icon name="issues" /> Issues
          </Link>
          {team.projects.length > 0 && <div className="section">Projects</div>}
          {team.projects
            .filter((p) => !CLOSED_STATES.includes(p.state))
            .map((project) => (
              <Link
                key={project.id}
                to={`/project/${project.id}`}
                className={active(`/project/${project.id}`)}
              >
                <Icon name="project" className="nested" /> {project.name}
              </Link>
            ))}
          {team.projects.some((p) => CLOSED_STATES.includes(p.state)) && (
            <>
              <button
                className="nav"
                onClick={() => setShowClosed((s) => ({ ...s, [team.id]: !s[team.id] }))}
              >
                <Icon
                  name={showClosed[team.id] ? "chevron-down" : "chevron-right"}
                  className="nested"
                />
                Completados ({team.projects.filter((p) => CLOSED_STATES.includes(p.state)).length})
              </button>
              {showClosed[team.id] &&
                team.projects
                  .filter((p) => CLOSED_STATES.includes(p.state))
                  .map((project) => (
                    <Link
                      key={project.id}
                      to={`/project/${project.id}`}
                      className={active(`/project/${project.id}`)}
                    >
                      <Icon name="project" className="nested-deep" />
                      <span style={{ opacity: 0.7 }}>{project.name}</span>
                    </Link>
                  ))}
            </>
          )}
        </div>
      ))}
      <div className="spacer" />
      <div className="hint">
        <kbd>C</kbd> new issue · <kbd>⌘K</kbd> commands
      </div>
      <Link to="/members" className={active("/members")}>
        <Icon name="members" /> Members
      </Link>
      <Link to="/settings" className={active("/settings")}>
        <Icon name="settings" /> Settings
      </Link>
    </nav>
  );
}
