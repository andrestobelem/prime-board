// Shell de la UI: sidebar + topbar + contenido ruteado por hash.
// Atajos globales: C crea un issue, ⌘K abre el command palette (AT-148).
import { useEffect, useState } from "react";
import { getApiKey, mutate, useQuery } from "./api.ts";
import { GROUP_LABELS, isTypingTarget, type GroupBy } from "./components/IssueList.tsx";
import { Palette } from "./components/Palette.tsx";
import { QuickCreate } from "./components/QuickCreate.tsx";
import { Icon } from "./components/icons.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
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

const SHELL_QUERY = `{
  workspace { id name }
  teams {
    id key name
    projects { id name state }
    cycles { id name number state }
  }
  initiatives { id name state }
  savedViews { id name scope team { id key } }
}`;

export interface ShellData {
  workspace: { id: string; name: string };
  teams: Array<{
    id: string;
    key: string;
    name: string;
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
}

export function App() {
  const route = useRoute();
  const hasKey = Boolean(getApiKey());
  const shell = useQuery<ShellData>(SHELL_QUERY);
  const [createOpen, setCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("state");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (isTypingTarget(event) || document.querySelector(".overlay")) return;
      if (event.key === "c" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setCreateOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const [section, param] = route;
  const teams = shell.data?.teams ?? [];
  const defaultTeam = teams[0]?.key;
  const currentTeamKey =
    section === "team" || section === "board"
      ? param
      : section === "issue" && param
        ? param.split("-")[0]
        : defaultTeam;

  let topbar = null;
  let content = <div className="loading">Loading…</div>;

  if (shell.error) {
    content = <div className="error-banner">{shell.error.message}</div>;
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
        <span className="title">Estados y labels</span>
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
                Agrupar por {GROUP_LABELS[key].toLowerCase()}
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
                Agrupar por {GROUP_LABELS[key].toLowerCase()}
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
    const project = shell.data?.teams
      .flatMap((team) => team.projects)
      .find((candidate) => candidate.id === param);
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
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
              {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
                <option key={key} value={key}>
                  Agrupar por {GROUP_LABELS[key].toLowerCase()}
                </option>
              ))}
            </select>
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
      <BoardView scope={{ kind: "project", projectId: param }} groupBy={groupBy} />
    ) : (
      <ProjectView projectId={param} />
    );
  } else if ((section === "team" || section === "board") && param) {
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
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
              {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
                <option key={key} value={key}>
                  Agrupar por {GROUP_LABELS[key].toLowerCase()}
                </option>
              ))}
            </select>
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
        />
      ) : (
        <TeamView teamKey={param} teamId={team?.id ?? null} groupBy={groupBy} />
      );
  } else if (shell.data) {
    if (defaultTeam) {
      window.location.hash = `#/team/${defaultTeam}`;
      content = <div className="loading">Loading…</div>;
    } else {
      content = <div className="empty">No teams yet.</div>;
    }
  }

  return (
    <div className="app">
      <Sidebar
        workspace={shell.data?.workspace ?? null}
        teams={teams}
        views={shell.data?.savedViews ?? []}
        initiatives={shell.data?.initiatives ?? []}
        onCreateView={async () => {
          const team = teams.find((candidate) => candidate.key === currentTeamKey) ?? teams[0];
          if (!team) return;
          const name = window.prompt("View name");
          if (!name?.trim()) return;
          const data = await mutate<{ savedViewCreate: { savedView: { id: string } } }>(
            `
            mutation($input: SavedViewCreateInput!) {
              savedViewCreate(input: $input) { savedView { id } }
            }
          `,
            {
              input: {
                name: name.trim(),
                scope: "TEAM",
                teamId: team.id,
                filter: { team: { eq: team.id } },
                orderBy: "UPDATED_DESC",
                groupBy,
              },
            },
          );
          window.location.hash = `#/view/${data.savedViewCreate.savedView.id}`;
        }}
        onCreateCycle={async (teamId) => {
          const name = window.prompt("Cycle name");
          if (!name?.trim()) return;
          const startsAt = new Date().toISOString();
          const ends = new Date();
          ends.setDate(ends.getDate() + 14);
          const data = await mutate<{ cycleCreate: { cycle: { id: string } } }>(
            `
            mutation($input: CycleCreateInput!) {
              cycleCreate(input: $input) { cycle { id } }
            }
          `,
            {
              input: {
                teamId,
                name: name.trim(),
                startsAt,
                endsAt: ends.toISOString(),
              },
            },
          );
          window.location.hash = `#/cycle/${data.cycleCreate.cycle.id}`;
        }}
        onCreateInitiative={async () => {
          const name = window.prompt("Initiative name");
          if (!name?.trim()) return;
          const data = await mutate<{ initiativeCreate: { initiative: { id: string } } }>(
            `
            mutation($input: InitiativeCreateInput!) {
              initiativeCreate(input: $input) { initiative { id } }
            }
          `,
            {
              input: { name: name.trim(), state: "ACTIVE" },
            },
          );
          window.location.hash = `#/initiative/${data.initiativeCreate.initiative.id}`;
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
        />
      )}
    </div>
  );
}
