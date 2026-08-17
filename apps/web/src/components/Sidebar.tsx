// Sidebar Linear-like: workspace y teams con sus proyectos anidados (AT-152).
// Views guardadas (PRB-201) aparecen como sección propia.
import { useEffect, useState } from "react";
import { Link, useRoute } from "../router.tsx";
import { Icon } from "./icons.tsx";
import type { NavigationView } from "../navigation.ts";

export interface SidebarFavorite {
  id: string;
  position: number;
  project: { id: string; name: string } | null;
  savedView: { id: string; name: string } | null;
}

type FavoriteTarget = { projectId?: string; savedViewId?: string };

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
  favorites?: SidebarFavorite[];
  onToggleFavorite?: (
    target: FavoriteTarget,
    current: SidebarFavorite | undefined,
  ) => void | Promise<void>;
  onReorderFavorite?: (favorite: SidebarFavorite, position: number) => void | Promise<void>;
  onLogout?: () => void;
  onCreateIssue?: () => void;
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
  favorites = [],
  onToggleFavorite,
  onReorderFavorite,
  onLogout,
  onCreateIssue,
  onCreateView,
  onCreateCycle,
  onCreateInitiative,
}: SidebarProps) {
  const route = useRoute();
  // Los proyectos cerrados se colapsan para no saturar el sidebar (AT-30).
  const [showClosed, setShowClosed] = useState<Record<string, boolean>>({});
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const favoriteFor = (target: FavoriteTarget) =>
    favorites.find((favorite) =>
      target.projectId
        ? favorite.project?.id === target.projectId
        : favorite.savedView?.id === target.savedViewId,
    );
  const toggleFavorite = (target: FavoriteTarget) => {
    if (onToggleFavorite) void onToggleFavorite(target, favoriteFor(target));
  };
  const active = (path: string) => (`/${route.join("/")}` === path ? "active" : "");
  const favoriteButton = (target: FavoriteTarget, label: string) => {
    if (!onToggleFavorite) return null;
    const current = favoriteFor(target);
    return (
      <button
        className="favorite-action"
        aria-label={current ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
        title={current ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(target)}
      >
        <Icon name={current ? "x" : "plus"} size={12} />
      </button>
    );
  };
  const renderProject = (
    project: { id: string; name: string; state: string },
    iconClass: string,
  ) => (
    <div className="resource-row" key={project.id}>
      <Link to={`/project/${project.id}`} className={active(`/project/${project.id}`)}>
        <Icon name="project" className={iconClass} /> {project.name}
      </Link>
      {favoriteButton({ projectId: project.id }, project.name)}
    </div>
  );
  const renderView = (view: NavigationView) => (
    <div className="resource-row" key={view.id}>
      <Link to={`/view/${view.id}`} className={active(`/view/${view.id}`)}>
        <Icon name="filter" className="nested" /> {view.name}
      </Link>
      {favoriteButton({ savedViewId: view.id }, view.name)}
    </div>
  );

  useEffect(() => setMobileOpen(false), [route.join("/")]);
  useEffect(() => setWorkspaceMenuOpen(false), [route.join("/")]);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceMenuOpen]);

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
        <div className="workspace-menu">
          <button
            className="workspace workspace-trigger"
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            aria-controls="workspace-menu"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
          >
            <Icon name="workspace" size={18} className="logo" />
            <span>{workspace?.name ?? "prime-board"}</span>
            <Icon name={workspaceMenuOpen ? "chevron-down" : "chevron-right"} size={12} />
          </button>
          {workspaceMenuOpen && (
            <div id="workspace-menu" className="workspace-menu-popup" role="menu">
              <Link
                to="/settings"
                className="workspace-menu-item"
                role="menuitem"
                onClick={() => setWorkspaceMenuOpen(false)}
              >
                <Icon name="settings" /> Settings
              </Link>
              <Link
                to="/members"
                className="workspace-menu-item"
                role="menuitem"
                onClick={() => setWorkspaceMenuOpen(false)}
              >
                <Icon name="members" /> Invite and manage members
              </Link>
              {onLogout && (
                <button
                  className="workspace-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    onLogout();
                  }}
                >
                  <Icon name="x" /> Log out
                </button>
              )}
            </div>
          )}
        </div>
        {onCreateIssue && (
          <button className="nav new-issue-nav" onClick={onCreateIssue}>
            <Icon name="plus" size={14} />
            <span>New issue</span>
            <kbd>C</kbd>
          </button>
        )}
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
        {(favorites.length > 0 || onToggleFavorite) && (
          <>
            <button
              className="nav favorites-heading"
              aria-expanded={favoritesOpen}
              onClick={() => setFavoritesOpen((open) => !open)}
            >
              <Icon name={favoritesOpen ? "chevron-down" : "chevron-right"} size={12} />
              <span>Favorites</span>
            </button>
            {favoritesOpen &&
              (favorites.length === 0 ? (
                <div className="hint" style={{ padding: "0 12px 8px" }}>
                  Pin a project or view to keep it here
                </div>
              ) : (
                favorites.map((favorite, index) => {
                  const target = favorite.project
                    ? { projectId: favorite.project.id }
                    : { savedViewId: favorite.savedView!.id };
                  const path = favorite.project
                    ? `/project/${favorite.project.id}`
                    : `/view/${favorite.savedView!.id}`;
                  const name = favorite.project?.name ?? favorite.savedView?.name ?? "Favorite";
                  return (
                    <div className="favorite-row" key={favorite.id}>
                      <Link to={path} className={active(path)}>
                        <Icon name={favorite.project ? "project" : "filter"} className="nested" />
                        <span>{name}</span>
                      </Link>
                      {onReorderFavorite && (
                        <span className="favorite-order">
                          <button
                            className="favorite-action"
                            aria-label={`Move ${name} up`}
                            title="Move up"
                            disabled={index === 0}
                            onClick={() => void onReorderFavorite(favorite, index - 1)}
                          >
                            <Icon name="arrow-up" size={11} />
                          </button>
                          <button
                            className="favorite-action"
                            aria-label={`Move ${name} down`}
                            title="Move down"
                            disabled={index === favorites.length - 1}
                            onClick={() => void onReorderFavorite(favorite, index + 1)}
                          >
                            <Icon name="arrow-down" size={11} />
                          </button>
                        </span>
                      )}
                      {onToggleFavorite && (
                        <button
                          className="favorite-action"
                          aria-label={`Remove ${name} from favorites`}
                          title="Remove from favorites"
                          onClick={() => toggleFavorite(target)}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </div>
                  );
                })
              ))}
          </>
        )}
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
        {views.map(renderView)}
        <div className="section">Your teams</div>
        {teams.map((team) => (
          <div key={team.id}>
            <div className="section">{team.name}</div>
            <Link to={`/team/${team.key}/home`} className={active(`/team/${team.key}/home`)}>
              <Icon name="workspace" /> Home
            </Link>
            <Link to={`/triage/${team.key}`} className={active(`/triage/${team.key}`)}>
              <Icon name="filter" /> Triage
            </Link>
            <Link to={`/team/${team.key}`} className={active(`/team/${team.key}`)}>
              <Icon name="issues" /> Issues
            </Link>
            {team.projects.length > 0 && <div className="section">Projects</div>}
            {team.projects
              .filter((p) => !CLOSED_STATES.includes(p.state))
              .map((project) => renderProject(project, "nested"))}
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
                    .map((project) => renderProject(project, "nested-deep"))}
              </>
            )}
            {team.views && team.views.length > 0 && <div className="section">Views</div>}
            {(team.views ?? []).map(renderView)}
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
