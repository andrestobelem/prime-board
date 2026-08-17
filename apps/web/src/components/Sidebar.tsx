// Sidebar Linear-like: workspace y teams con sus proyectos anidados (AT-152).
// Views guardadas (PRB-201) aparecen como sección propia.
import { useEffect, useState } from "react";
import { Link, useRoute } from "../router.tsx";
import { Icon } from "./icons.tsx";

interface SidebarProps {
  workspace: { name: string } | null;
  teams: Array<{
    id: string;
    key: string;
    name: string;
    projects: Array<{ id: string; name: string; state: string }>;
    cycles?: Array<{ id: string; name: string; number: number; state: string }>;
    views?: Array<{
      id: string;
      name: string;
      scope: string;
      team: { id: string; key: string } | null;
    }>;
  }>;
  views?: Array<{
    id: string;
    name: string;
    scope: string;
    team: { id: string; key: string } | null;
  }>;
  initiatives?: Array<{ id: string; name: string; state: string }>;
  onCreateView?: () => void | Promise<void>;
  onCreateCycle?: (teamId: string) => void | Promise<void>;
  onCreateInitiative?: () => void | Promise<void>;
}

const CLOSED_STATES = ["COMPLETED", "CANCELED"];

export function Sidebar({
  workspace,
  teams,
  views = [],
  initiatives = [],
  onCreateView,
  onCreateCycle,
  onCreateInitiative,
}: SidebarProps) {
  const route = useRoute();
  // Los proyectos cerrados se colapsan para no saturar el sidebar (AT-30).
  const [showClosed, setShowClosed] = useState<Record<string, boolean>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const active = (path: string) => (`/${route.join("/")}` === path ? "active" : "");

  useEffect(() => setMobileOpen(false), [route.join("/")]);

  return (
    <>
      <button
        className={`mobile-sidebar-toggle${mobileOpen ? " hidden" : ""}`}
        aria-label="Open sidebar"
        onClick={() => setMobileOpen(true)}
      >
        <Icon name="menu" size={18} />
      </button>
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <nav className={`sidebar${mobileOpen ? " mobile-open" : ""}`}>
        <button
          className="mobile-sidebar-close"
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
        >
          <Icon name="x" size={18} />
        </button>
        <div className="workspace">
          <Icon name="workspace" size={18} className="logo" />
          {workspace?.name ?? "prime-board"}
        </div>
        <div className="section">Workspace</div>
        <Link to="/teams" className={active("/teams")}>
          <Icon name="members" /> Teams
        </Link>
        <Link to="/inbox" className={active("/inbox")}>
          <Icon name="comment" /> Inbox
        </Link>
        <Link to="/my" className={active("/my")}>
          <Icon name="assignee" /> My issues
        </Link>
        <Link to="/reviews" className={active("/reviews")}>
          <Icon name="check" /> Reviews
        </Link>
        <Link to="/projects" className={active("/projects")}>
          <Icon name="project" /> Projects
        </Link>
        <div className="section" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1 }}>Initiatives</span>
          {onCreateInitiative && (
            <button
              className="nav"
              style={{ padding: 0, margin: 0, width: "auto" }}
              title="New initiative"
              onClick={() => void onCreateInitiative()}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
        </div>
        {initiatives.map((initiative) => (
          <Link
            key={initiative.id}
            to={`/initiative/${initiative.id}`}
            className={active(`/initiative/${initiative.id}`)}
          >
            <Icon name="milestone" className="nested" /> {initiative.name}
          </Link>
        ))}
        <div className="section" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1 }}>Views</span>
          {onCreateView && (
            <button
              className="nav"
              style={{ padding: 0, margin: 0, width: "auto" }}
              title="New view"
              onClick={() => void onCreateView()}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
        </div>
        {views.length === 0 && (
          <div className="hint" style={{ padding: "0 12px 8px" }}>
            No workspace views yet
          </div>
        )}
        {views.map((view) => (
          <Link key={view.id} to={`/view/${view.id}`} className={active(`/view/${view.id}`)}>
            <Icon name="filter" className="nested" /> {view.name}
          </Link>
        ))}
        {teams.map((team) => (
          <div key={team.id}>
            <div className="section">{team.name}</div>
            <Link to={`/triage/${team.key}`} className={active(`/triage/${team.key}`)}>
              <Icon name="filter" /> Triage
            </Link>
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
                  Completed ({team.projects.filter((p) => CLOSED_STATES.includes(p.state)).length})
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
            {team.views && team.views.length > 0 && <div className="section">Views</div>}
            {(team.views ?? []).map((view) => (
              <Link key={view.id} to={`/view/${view.id}`} className={active(`/view/${view.id}`)}>
                <Icon name="filter" className="nested" /> {view.name}
              </Link>
            ))}
            <div className="section" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ flex: 1 }}>Cycles</span>
              {onCreateCycle && (
                <button
                  className="nav"
                  style={{ padding: 0, margin: 0, width: "auto" }}
                  title="New cycle"
                  onClick={() => void onCreateCycle(team.id)}
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
            {(team.cycles ?? []).map((cycle) => (
              <Link
                key={cycle.id}
                to={`/cycle/${cycle.id}`}
                className={active(`/cycle/${cycle.id}`)}
              >
                <Icon name="calendar" className="nested" /> {cycle.name}
              </Link>
            ))}
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
    </>
  );
}
