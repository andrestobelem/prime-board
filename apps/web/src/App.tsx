// Shell de la UI: sidebar + topbar + contenido ruteado por hash.
// Atajos globales: C crea un issue, ⌘K abre el command palette (AT-148).
import { useEffect, useState } from "react";
import { getApiKey, mutate, useQuery } from "./api.ts";
import { GROUP_LABELS, isTypingTarget, type GroupBy } from "./components/IssueList.tsx";
import { DisplayOptions, type IssueColumn, type IssueOrder } from "./components/DisplayOptions.tsx";
import { ErrorState } from "./components/AsyncState.tsx";
import { Palette } from "./components/Palette.tsx";
import { QuickCreate } from "./components/QuickCreate.tsx";
import { Icon } from "./components/icons.tsx";
import { Sidebar, type SidebarFavorite } from "./components/Sidebar.tsx";
import { EntityModal } from "./components/EntityModal.tsx";
import { Switcher } from "./components/Switcher.tsx";
import { Link, useRoute } from "./router.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { IssueView } from "./views/IssueView.tsx";
import { MembersView } from "./views/MembersView.tsx";
import { ProjectView } from "./views/ProjectView.tsx";
import { SavedViewPage } from "./views/SavedViewPage.tsx";
import { InitiativeView } from "./views/InitiativeView.tsx";
import { ReviewsView } from "./views/ReviewsView.tsx";
import { CycleView } from "./views/CycleView.tsx";
import { MyIssuesView } from "./views/MyIssuesView.tsx";
import { InboxView } from "./views/InboxView.tsx";
import { TeamSettingsView } from "./views/TeamSettingsView.tsx";
import { TeamView } from "./views/TeamView.tsx";
import { TeamHomeView } from "./views/TeamHomeView.tsx";
import { TeamsView } from "./views/TeamsView.tsx";
import { ProjectsView } from "./views/ProjectsView.tsx";
import { buildNavigation, getDefaultTeamPath, getTeamKeyForRoute } from "./navigation.ts";

const SHELL_QUERY = `{
  workspace { id name }
  teams {
    id key name accessPolicy
    projects { id name state }
    cycles { id name number state }
  }
  initiatives { id name state }
  savedViews { id name scope team { id key } }
  inboxUnreadCount
  favorites {
    id position
    project { id name }
    savedView { id name }
  }
}`;

type CreateModal =
  | {
      kind: "view";
      scope: "WORKSPACE" | "TEAM" | "PERSONAL";
      team: { id: string; key: string; name: string } | null;
    }
  | { kind: "cycle"; teamId: string }
  | { kind: "initiative" };

export interface ShellData {
  workspace: { id: string; name: string };
  teams: Array<{
    id: string;
    key: string;
    name: string;
    accessPolicy: string;
    projects: Array<{ id: string; name: string; state: string }>;
    cycles: Array<{ id: string; name: string; number: number; state: string }>;
  }>;
  initiatives: Array<{ id: string; name: string; state: string }>;
  savedViews: Array<{
    id: string;
    name: string;
    scope: string;
    team: { id: string; key: string } | null;
  }>;
  favorites: SidebarFavorite[];
  inboxUnreadCount: number;
}

function loadGroupBy(): GroupBy {
  const value = localStorage.getItem("pb.group-by");
  return value === "state" || value === "milestone" || value === "assignee" || value === "priority"
    ? value
    : "state";
}

const DEFAULT_COLUMNS: IssueColumn[] = ["priority", "labels", "assignee"];
function loadOrderBy(): IssueOrder {
  const value = localStorage.getItem("pb.order-by");
  return value === "CREATED_ASC" ||
    value === "CREATED_DESC" ||
    value === "UPDATED_ASC" ||
    value === "UPDATED_DESC"
    ? value
    : "UPDATED_DESC";
}
function loadColumns(): IssueColumn[] {
  try {
    const value = JSON.parse(localStorage.getItem("pb.visible-columns") ?? "null");
    return Array.isArray(value) && value.length ? value : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

export function App() {
  const route = useRoute();
  const [hasKey, setHasKey] = useState(() => Boolean(getApiKey()));
  const shell = useQuery<ShellData>(SHELL_QUERY);
  const [createOpen, setCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [entityModal, setEntityModal] = useState<CreateModal | null>(null);
  const [favorites, setFavorites] = useState<SidebarFavorite[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>(loadGroupBy);
  const [orderBy, setOrderBy] = useState<IssueOrder>(loadOrderBy);
  const [visibleColumns, setVisibleColumns] = useState<IssueColumn[]>(loadColumns);

  useEffect(() => {
    localStorage.setItem("pb.group-by", groupBy);
    localStorage.setItem("pb.order-by", orderBy);
    localStorage.setItem("pb.visible-columns", JSON.stringify(visibleColumns));
  }, [groupBy, orderBy, visibleColumns]);

  useEffect(() => {
    if (shell.data) setFavorites(shell.data.favorites);
  }, [shell.data]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (isTypingTarget(event) || document.querySelector(".overlay")) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      if (event.key === "c" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setCreateOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function archiveCurrentIssue(): Promise<void> {
    const issueRef = route[0] === "issue" ? (route[1] ?? null) : null;
    if (!issueRef) return;
    await mutate<{ issueArchive: { success: boolean } }>(
      `mutation($id: ID!) { issueArchive(id: $id) { success } }`,
      { id: issueRef },
    );
    window.location.hash = "#/my-issues";
  }

  const toggleFavorite = async (
    target: { projectId?: string; savedViewId?: string },
    current: SidebarFavorite | undefined,
  ) => {
    if (current) {
      await mutate(`mutation($id: ID!) { favoriteDelete(id: $id) { success } }`, {
        id: current.id,
      });
      setFavorites((items) => items.filter((item) => item.id !== current.id));
      return;
    }
    const result = await mutate<{
      favoriteCreate: { favorite: { id: string; position: number } };
    }>(
      `mutation($input: FavoriteCreateInput!) { favoriteCreate(input: $input) { favorite { id position } } }`,
      { input: target },
    );
    const project = target.projectId
      ? navigation.projects.find((item) => item.id === target.projectId)
      : null;
    const view = target.savedViewId
      ? shell.data?.savedViews.find((item) => item.id === target.savedViewId)
      : null;
    setFavorites((items) => [
      ...items,
      {
        id: result.favoriteCreate.favorite.id,
        position: result.favoriteCreate.favorite.position,
        project: project ? { id: project.id, name: project.name } : null,
        savedView: view ? { id: view.id, name: view.name } : null,
      },
    ]);
  };

  const logout = () => {
    localStorage.removeItem("pb.apiKey");
    setFavorites([]);
    setHasKey(false);
  };

  const reorderFavorite = async (favorite: SidebarFavorite, position: number) => {
    await mutate(
      `mutation($id: ID!, $position: Int!) { favoriteReorder(id: $id, position: $position) { favorite { id position } } }`,
      { id: favorite.id, position },
    );
    setFavorites((items) => {
      const currentIndex = items.findIndex((item) => item.id === favorite.id);
      if (currentIndex < 0) return items;
      const next = [...items];
      const [selected] = next.splice(currentIndex, 1);
      next.splice(Math.min(position, next.length), 0, selected!);
      return next.map((item, index) => ({ ...item, position: index }));
    });
  };

  if (!hasKey || (shell.error && shell.error.code === "UNAUTHORIZED")) {
    return (
      <div className="app">
        <div className="main">
          <div className="topbar">
            <span className="title">Welcome to prime-board</span>
          </div>
          <SettingsView />
        </div>
      </div>
    );
  }

  const [section, param, subroute] = route;
  const teams = shell.data?.teams ?? [];
  const navigation = buildNavigation(teams, shell.data?.savedViews ?? []);
  const defaultTeam = teams[0]?.key;
  const currentTeamKey =
    getTeamKeyForRoute(
      route,
      teams.map((team) => ({ key: team.key, projects: team.projects, cycles: team.cycles })),
    ) ?? defaultTeam;

  let topbar = null;
  let content = <div className="loading">Loading…</div>;

  if (shell.error) {
    content = <ErrorState message={shell.error.message} onRetry={shell.refetch} />;
  } else if (section === "teams") {
    topbar = <span className="title">Teams</span>;
    content = <TeamsView teams={teams} />;
  } else if (section === "projects") {
    topbar = <span className="title">Projects</span>;
    content = <ProjectsView projects={navigation.projects} />;
  } else if (section === "settings") {
    topbar = <span className="title">Settings</span>;
    content = <SettingsView />;
  } else if (section === "team-settings" && param) {
    topbar = (
      <>
        <Link to={`/team/${param}`}>
          <span className="crumb">{param}</span>
        </Link>
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">States & labels</span>
      </>
    );
    content = <TeamSettingsView teamKey={param} />;
  } else if (section === "members") {
    topbar = <span className="title">Members</span>;
    content = <MembersView />;
  } else if (section === "inbox") {
    topbar = <span className="title">Inbox</span>;
    content = <InboxView />;
  } else if (section === "reviews") {
    topbar = <span className="title">Reviews</span>;
    content = <ReviewsView />;
  } else if (section === "initiative" && param) {
    const initiative = shell.data?.initiatives.find((item) => item.id === param);
    topbar = (
      <>
        <span className="crumb">Initiatives</span>
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">{initiative?.name ?? "Initiative"}</span>
      </>
    );
    content = <InitiativeView initiativeId={param} />;
  } else if (section === "my") {
    topbar = (
      <>
        <span className="title">My issues</span>
        <span className="right">
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
              <option key={key} value={key}>
                Group by {GROUP_LABELS[key].toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </>
    );
    content = <MyIssuesView groupBy={groupBy} />;
  } else if (section === "cycle" && param) {
    const cycle = teams.flatMap((team) => team.cycles ?? []).find((c) => c.id === param);
    topbar = (
      <>
        <span className="crumb">Cycles</span>
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">{cycle?.name ?? "Cycle"}</span>
        <span className="right">
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
              <option key={key} value={key}>
                Group by {GROUP_LABELS[key].toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </>
    );
    content = <CycleView cycleId={param} groupBy={groupBy} />;
  } else if (section === "view" && param) {
    const view = shell.data?.savedViews.find((candidate) => candidate.id === param);
    topbar = (
      <>
        <span className="crumb">Views</span>
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">{view?.name ?? "View"}</span>
      </>
    );
    content = <SavedViewPage viewId={param} />;
  } else if (section === "triage" && param) {
    const team = teams.find((candidate) => candidate.key === param);
    topbar = team ? (
      <>
        <Switcher teams={teams} current={{ kind: "team", key: param }} view="team" />
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">Triage</span>
      </>
    ) : (
      <span className="title">Triage</span>
    );
    content = team ? (
      <TeamView key={`triage-${param}`} teamKey={param} teamId={team.id} groupBy={groupBy} triage />
    ) : (
      <div className="empty">Team {param} not found.</div>
    );
  } else if (section === "team" && param && subroute === "home") {
    const team = teams.find((candidate) => candidate.key === param);
    topbar = team ? (
      <>
        <Switcher teams={teams} current={{ kind: "team", key: param }} view="team" />
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">Home</span>
      </>
    ) : (
      <span className="title">Team home</span>
    );
    content = team ? (
      <TeamHomeView team={team} />
    ) : (
      <div className="empty">Team {param} not found.</div>
    );
  } else if (section === "issue" && param) {
    const teamKey = param.split("-")[0];
    topbar = (
      <>
        <Link to={`/team/${teamKey}`}>
          <span className="crumb">{teamKey}</span>
        </Link>
        <Icon name="chevron-right" size={14} className="crumb-sep" />
        <span className="title">{param}</span>
      </>
    );
    content = <IssueView issueRef={param} />;
  } else if ((section === "project" || section === "project-board") && param) {
    const project = navigation.projects.find((candidate) => candidate.id === param);
    const boardActive = section === "project-board";
    topbar = (
      <>
        <Switcher
          teams={teams}
          current={{ kind: "project", id: param }}
          view={boardActive ? "board" : "team"}
        />
        {project?.state && <span className="crumb">{project.state.toLowerCase()}</span>}
        <span className="right">
          {boardActive && (
            <DisplayOptions
              groupBy={groupBy}
              orderBy={orderBy}
              columns={visibleColumns}
              onGroupBy={setGroupBy}
              onOrderBy={setOrderBy}
              onColumns={setVisibleColumns}
            />
          )}
          <span className="tabs">
            <Link to={`/project/${param}`}>
              <button className={boardActive ? "" : "active"}>List</button>
            </Link>
            <Link to={`/project-board/${param}`}>
              <button className={boardActive ? "active" : ""}>Board</button>
            </Link>
          </span>
        </span>
      </>
    );
    content = boardActive ? (
      <BoardView
        scope={{ kind: "project", projectId: param }}
        groupBy={groupBy}
        orderBy={orderBy}
        visibleColumns={visibleColumns}
      />
    ) : (
      <ProjectView projectId={param} />
    );
  } else if ((section === "team" || section === "board") && param && !subroute) {
    const team = teams.find((candidate) => candidate.key === param);
    topbar = (
      <>
        <Switcher
          teams={teams}
          current={{ kind: "team", key: param }}
          view={section === "board" ? "board" : "team"}
        />
        <span className="right">
          {(section === "team" || section === "board") && (
            <Link to={`/team-settings/${param}`}>
              <button className="btn secondary">
                <Icon name="settings" size={14} /> Team
              </button>
            </Link>
          )}
          {(section === "team" || section === "board") && (
            <DisplayOptions
              groupBy={groupBy}
              orderBy={orderBy}
              columns={visibleColumns}
              onGroupBy={setGroupBy}
              onOrderBy={setOrderBy}
              onColumns={setVisibleColumns}
            />
          )}
          <span className="tabs">
            <Link to={`/team/${param}`}>
              <button className={section === "team" ? "active" : ""}>List</button>
            </Link>
            <Link to={`/board/${param}`}>
              <button className={section === "board" ? "active" : ""}>Board</button>
            </Link>
          </span>
        </span>
      </>
    );
    content =
      section === "board" ? (
        <BoardView
          scope={{ kind: "team", teamKey: param, teamId: team?.id ?? null }}
          groupBy={groupBy}
          orderBy={orderBy}
          visibleColumns={visibleColumns}
        />
      ) : (
        <TeamView
          teamKey={param}
          teamId={team?.id ?? null}
          groupBy={groupBy}
          orderBy={orderBy}
          visibleColumns={visibleColumns}
        />
      );
  } else if (shell.data) {
    if (defaultTeam) {
      window.location.hash = `#${getDefaultTeamPath(defaultTeam)}`;
      content = <div className="loading">Loading…</div>;
    } else {
      content = <div className="empty">No teams yet.</div>;
    }
  }

  return (
    <div className="app">
      <Sidebar
        workspace={shell.data?.workspace ?? null}
        teams={teams.map((team) => ({
          ...team,
          views: navigation.teams.find((candidate) => candidate.id === team.id)?.views ?? [],
        }))}
        views={navigation.workspaceViews}
        favorites={favorites}
        unreadInboxCount={shell.data?.inboxUnreadCount ?? 0}
        onToggleFavorite={toggleFavorite}
        onReorderFavorite={reorderFavorite}
        onLogout={logout}
        onCreateIssue={() => setCreateOpen(true)}
        initiatives={shell.data?.initiatives ?? []}
        onCreateView={async (teamId) => {
          const team = teamId ? (teams.find((candidate) => candidate.id === teamId) ?? null) : null;
          setEntityModal({ kind: "view", scope: team ? "TEAM" : "WORKSPACE", team });
        }}
        onCreateCycle={async (teamId) => {
          setEntityModal({ kind: "cycle", teamId });
        }}
        onCreateInitiative={async () => {
          setEntityModal({ kind: "initiative" });
        }}
      />
      <div className="main">
        {topbar && <div className="topbar">{topbar}</div>}
        <div className="content">{content}</div>
      </div>
      {createOpen && (
        <QuickCreate
          teams={teams}
          defaultTeamKey={currentTeamKey}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {paletteOpen && shell.data && (
        <Palette
          shell={shell.data}
          onClose={() => setPaletteOpen(false)}
          onNewIssue={() => setCreateOpen(true)}
          currentIssueRef={route[0] === "issue" ? (route[1] ?? null) : null}
          onArchiveCurrentIssue={archiveCurrentIssue}
        />
      )}
      {shortcutsOpen && (
        <div
          className="overlay"
          onMouseDown={(event) => event.target === event.currentTarget && setShortcutsOpen(false)}
        >
          <div
            className="modal shortcuts-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
          >
            <div className="modal-header">
              <h2 id="shortcuts-title">Keyboard shortcuts</h2>
              <button
                className="icon-action"
                aria-label="Close shortcuts"
                onClick={() => setShortcutsOpen(false)}
              >
                ×
              </button>
            </div>
            <dl className="shortcut-list">
              <dt>
                <kbd>C</kbd>
              </dt>
              <dd>Create an issue</dd>
              <dt>
                <kbd>⌘/Ctrl K</kbd>
              </dt>
              <dd>Open command palette</dd>
              <dt>
                <kbd>J</kbd> / <kbd>K</kbd>
              </dt>
              <dd>Move issue focus</dd>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>Open focused issue</dd>
              <dt>
                <kbd>X</kbd>
              </dt>
              <dd>Archive focused issue</dd>
              <dt>
                <kbd>Shift X</kbd>
              </dt>
              <dd>Archive selected issues</dd>
              <dt>
                <kbd>⌘/Ctrl A</kbd>
              </dt>
              <dd>Select visible issues</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Clear selection or close an overlay</dd>
              <dt>
                <kbd>?</kbd>
              </dt>
              <dd>Show this help</dd>
            </dl>
          </div>
        </div>
      )}
      {entityModal?.kind === "view" && (
        <EntityModal
          title="Create view"
          submitLabel="Create view"
          fields={[
            { key: "name", label: "Name", placeholder: "View name" },
            {
              key: "scope",
              label: "Scope",
              type: "select",
              value: entityModal.scope,
              options: [
                { value: "WORKSPACE", label: "Workspace" },
                { value: "TEAM", label: "Team" },
                { value: "PERSONAL", label: "Personal" },
              ],
            },
            {
              key: "teamId",
              label: "Team filter (optional)",
              type: "select",
              value: entityModal.team?.id ?? "",
              options: [
                { value: "", label: "All teams" },
                ...teams.map((team) => ({ value: team.id, label: team.name })),
              ],
            },
          ]}
          onClose={() => setEntityModal(null)}
          onSubmit={async (values) => {
            const name = values.name?.trim();
            if (!name) throw new Error("Name is required");
            const scope = (values.scope || entityModal.scope) as "WORKSPACE" | "TEAM" | "PERSONAL";
            const teamId = values.teamId || undefined;
            if (scope === "TEAM" && !teamId) throw new Error("Select a team for a team view");
            const data = await mutate<{ savedViewCreate: { savedView: { id: string } } }>(
              `mutation($input: SavedViewCreateInput!) {
                savedViewCreate(input: $input) { savedView { id } }
              }`,
              {
                input: {
                  name,
                  scope,
                  teamId: scope === "TEAM" ? teamId : undefined,
                  filter: teamId ? { team: { eq: teamId } } : {},
                  orderBy: "UPDATED_DESC",
                  groupBy,
                  columns: visibleColumns,
                },
              },
            );
            setEntityModal(null);
            window.location.hash = `#/view/${data.savedViewCreate.savedView.id}`;
          }}
        />
      )}
      {entityModal?.kind === "cycle" && (
        <EntityModal
          title="Create cycle"
          submitLabel="Create cycle"
          fields={[
            { key: "name", label: "Name", placeholder: "Cycle name" },
            {
              key: "startsAt",
              label: "Starts",
              type: "date",
              value: new Date().toISOString().slice(0, 10),
            },
            {
              key: "endsAt",
              label: "Ends",
              type: "date",
              value: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            },
          ]}
          onClose={() => setEntityModal(null)}
          onSubmit={async (values) => {
            const name = values.name?.trim();
            if (!name) throw new Error("Name is required");
            if (!values.startsAt || !values.endsAt) throw new Error("Dates are required");
            const data = await mutate<{ cycleCreate: { cycle: { id: string } } }>(
              `mutation($input: CycleCreateInput!) {
                cycleCreate(input: $input) { cycle { id } }
              }`,
              {
                input: {
                  teamId: entityModal.teamId,
                  name,
                  startsAt: `${values.startsAt}T00:00:00.000Z`,
                  endsAt: `${values.endsAt}T00:00:00.000Z`,
                },
              },
            );
            setEntityModal(null);
            window.location.hash = `#/cycle/${data.cycleCreate.cycle.id}`;
          }}
        />
      )}
      {entityModal?.kind === "initiative" && (
        <EntityModal
          title="Create initiative"
          submitLabel="Create initiative"
          fields={[
            { key: "name", label: "Name", placeholder: "Initiative name" },
            {
              key: "teamId",
              label: "Scope",
              type: "select",
              value: "",
              options: [
                { value: "", label: "Workspace" },
                ...teams.map((team) => ({ value: team.id, label: `Team: ${team.key}` })),
              ],
            },
          ]}
          onClose={() => setEntityModal(null)}
          onSubmit={async (values) => {
            const name = values.name?.trim();
            if (!name) throw new Error("Name is required");
            const data = await mutate<{ initiativeCreate: { initiative: { id: string } } }>(
              `mutation($input: InitiativeCreateInput!) {
                initiativeCreate(input: $input) { initiative { id } }
              }`,
              { input: { name, state: "ACTIVE", teamIds: values.teamId ? [values.teamId] : [] } },
            );
            setEntityModal(null);
            window.location.hash = `#/initiative/${data.initiativeCreate.initiative.id}`;
          }}
        />
      )}
    </div>
  );
}
