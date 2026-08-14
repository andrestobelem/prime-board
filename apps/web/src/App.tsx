// Shell de la UI: sidebar + topbar + contenido ruteado por hash.
// Atajos globales: C crea un issue, ⌘K abre el command palette (AT-148).
import { useEffect, useState } from "react";
import { getApiKey, useQuery } from "./api.ts";
import { isTypingTarget } from "./components/IssueList.tsx";
import { Palette } from "./components/Palette.tsx";
import { QuickCreate } from "./components/QuickCreate.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Link, useRoute } from "./router.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { IssueView } from "./views/IssueView.tsx";
import { TeamView } from "./views/TeamView.tsx";

const SHELL_QUERY = `{
  workspace { id name }
  teams { id key name }
  projects { id name state }
}`;

export interface ShellData {
  workspace: { id: string; name: string };
  teams: Array<{ id: string; key: string; name: string }>;
  projects: Array<{ id: string; name: string; state: string }>;
}

export function App() {
  const route = useRoute();
  const hasKey = Boolean(getApiKey());
  const shell = useQuery<ShellData>(SHELL_QUERY);
  const [createOpen, setCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
  } else if ((section === "team" || section === "board") && param) {
    const team = teams.find((candidate) => candidate.key === param);
    topbar = (
      <>
        <span className="title">{team?.name ?? param}</span>
        <span className="right">
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
      ? <BoardView teamKey={param} teamId={team?.id ?? null} />
      : <TeamView teamKey={param} teamId={team?.id ?? null} />;
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
        projects={shell.data?.projects ?? []}
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
