// Shell de la UI: sidebar + contenido ruteado por hash (AT-144).
import { getApiKey, useQuery } from "./api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { useRoute } from "./router.tsx";
import { SettingsView } from "./views/SettingsView.tsx";

const SHELL_QUERY = `{
  workspace { id name }
  teams { id key name }
  projects { id name state }
}`;

export function App() {
  const route = useRoute();
  const hasKey = Boolean(getApiKey());
  const shell = useQuery<{
    workspace: { id: string; name: string };
    teams: Array<{ id: string; key: string; name: string }>;
    projects: Array<{ id: string; name: string; state: string }>;
  }>(SHELL_QUERY);

  // Sin key (o key inválida) → onboarding directo a settings.
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

  const [section] = route;
  const defaultTeam = shell.data?.teams[0]?.key;

  let content = <div className="loading">Loading…</div>;
  if (shell.error) {
    content = <div className="error-banner">{shell.error.message}</div>;
  } else if (section === "settings") {
    content = <SettingsView />;
  } else if (shell.data) {
    // Las vistas de issues llegan en AT-145+; por ahora el shell muestra el estado.
    content = (
      <div className="empty">
        {defaultTeam
          ? `Team ${defaultTeam} ready — issue views land in AT-145.`
          : "No teams yet."}
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        workspace={shell.data?.workspace ?? null}
        teams={shell.data?.teams ?? []}
        projects={shell.data?.projects ?? []}
      />
      <div className="main">{content}</div>
    </div>
  );
}
