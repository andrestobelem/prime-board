// Shell de la UI: sidebar + topbar + contenido ruteado por hash.
// Atajos globales: C crea un issue, ⌘K abre el command palette (AT-148).
import { useEffect, useState } from "react";
import { getApiKey, useQuery } from "./api.ts";
import { GROUP_LABELS, isTypingTarget, type GroupBy } from "./components/IssueList.tsx";
import { Palette } from "./components/Palette.tsx";
import { QuickCreate } from "./components/QuickCreate.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Link, useRoute } from "./router.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { IssueView } from "./views/IssueView.tsx";
import { MembersView } from "./views/MembersView.tsx";
import { ProjectView } from "./views/ProjectView.tsx";
import { TeamSettingsView } from "./views/TeamSettingsView.tsx";
import { TeamView } from "./views/TeamView.tsx";

const SHELL_QUERY = `{
  workspace { id name }
  teams { id key name projects { id name state } }
}`;

export interface ShellData {
  workspace: { id: string; name: string };
  teams: Array<{
    id: string;
    key: string;
    name: string;
    projects: Array<{ id: string; name: string; state: string }>;
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
          <div className="topbar"><span className="title">Welcome to prime-board</span></div>
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
        <Link to={`/team/${param}`}><span className="crumb">{param}</span></Link>
        <span className="crumb">›</span>
        <span className="title">Estados y labels</span>
      </>
    );
    content = <TeamSettingsView teamKey={param} />;
  } else if (section === "members") {
    topbar = <span className="title">Members</span>;
    content = <MembersView />;
  } else if (section === "issue" && param) {
    const teamKey = param.split("-")[0];
    topbar = (
      <>
        <Link to={`/team/${teamKey}`}><span className="crumb">{teamKey}</span></Link>
        <span className="crumb">›</span>
        <span className="title">{param}</span>
      </>
    );
    content = <IssueView issueRef={param} />;
  } else if (section === "project" && param) {
    const project = shell.data?.teams
      .flatMap((team) => team.projects)
      .find((candidate) => candidate.id === param);
    topbar = (
      <>
        <span className="crumb">Projects</span>
        <span className="crumb">›</span>
        <span className="title">{project?.name ?? "Project"}</span>
      </>
    );
    content = <ProjectView projectId={param} />;
  } else if ((section === "team" || section === "board") && param) {
    const team = teams.find((candidate) => candidate.key === param);
    topbar = (
      <>
        <span className="title">{team?.name ?? param}</span>
        <span className="right">
          {(section === "team" || section === "board") && (
            <Link to={`/team-settings/${param}`}>
              <button className="btn secondary">⚙ Team</button>
            </Link>
          )}
          {(section === "team" || section === "board") && (
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)}>
              {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
                <option key={key} value={key}>Agrupar por {GROUP_LABELS[key].toLowerCase()}</option>
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
    content = section === "board"
      ? <BoardView teamKey={param} teamId={team?.id ?? null} groupBy={groupBy} />
      : <TeamView teamKey={param} teamId={team?.id ?? null} groupBy={groupBy} />;
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
      <Sidebar workspace={shell.data?.workspace ?? null} teams={teams} />
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
