// Settings: la API key se pega una vez y queda en localStorage (spec §9).
import { useCallback, useEffect, useState } from "react";
import { getApiKey, gql, mutate, setApiContext, setApiKey } from "../api.ts";
import {
  clearStagedOnboardingKey,
  getStagedOnboardingKey,
  shouldUseOnboardingKey,
} from "../onboarding.ts";
import {
  getThemePreference,
  isThemePreference,
  setThemePreference,
  THEME_OPTIONS,
  type ThemePreference,
} from "../theme.ts";
import { navigate } from "../router.tsx";
import { ConfirmModal } from "../components/EntityModal.tsx";
import {
  teamDeletionDependencyMessage,
  validateWorkspaceName,
  type WorkspaceAdminTeam,
} from "../workspace-admin.ts";

const ADMIN_QUERY = `query WorkspaceAdministration {
  viewer { id workspaceRole }
  workspace { id name urlKey }
  teams(includeArchived: true) {
    id key name archivedAt
    projects { id }
    cycles { id }
    labels { id }
  }
}`;

type AdminData = {
  viewer: { id: string; workspaceRole: string };
  workspace: { id: string; name: string; urlKey: string };
  teams: WorkspaceAdminTeam[];
};

type TeamAction = {
  kind: "archive" | "restore" | "delete";
  team: WorkspaceAdminTeam;
};

export function SettingsView({ localAuth = false }: { localAuth?: boolean }) {
  const [onboardingKey] = useState(() => getStagedOnboardingKey());
  const existingKey = localAuth ? "local" : getApiKey();
  const useOnboardingKey = !localAuth && shouldUseOnboardingKey(existingKey, onboardingKey);
  const onboardingConflict = Boolean(
    !localAuth &&
    onboardingKey &&
    existingKey &&
    !useOnboardingKey &&
    existingKey !== onboardingKey,
  );
  const [key, setKey] = useState(() =>
    useOnboardingKey ? onboardingKey : localAuth ? "" : existingKey || onboardingKey,
  );
  const [status, setStatus] = useState<string | null>(() => {
    if (localAuth) return "Local mode is active. This server does not require an API key.";
    if (!onboardingKey) return null;
    if (onboardingConflict) return "An onboarding key was detected; your existing key was kept.";
    if (existingKey) return "This onboarding key is already saved in this browser.";
    return "Onboarding key loaded. Save & connect to continue.";
  });
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());
  const [adminData, setAdminData] = useState<AdminData | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [workspaceRenameOpen, setWorkspaceRenameOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [teamAction, setTeamAction] = useState<TeamAction | null>(null);

  const isAdmin = adminData?.viewer.workspaceRole?.toUpperCase() === "ADMIN";

  const loadAdmin = useCallback(async () => {
    if (!localAuth && !existingKey) return;
    setAdminLoading(true);
    setAdminError(null);
    try {
      const data = await gql<AdminData>(ADMIN_QUERY);
      setAdminData(data);
      setWorkspaceName(data.workspace.name);
    } catch (cause) {
      setAdminError(
        cause instanceof Error ? cause.message : "Could not load administration settings.",
      );
    } finally {
      setAdminLoading(false);
    }
  }, [existingKey, localAuth]);

  useEffect(() => {
    if (onboardingKey) clearStagedOnboardingKey();
  }, [onboardingKey]);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  function changeTheme(next: ThemePreference) {
    setTheme(next);
    setThemePreference(next);
  }

  async function save() {
    const nextKey = key.trim();
    if (!nextKey) {
      setStatus("Enter an API key to connect.");
      return;
    }
    setApiKey(nextKey);
    try {
      const data = await gql<{
        viewer: { id: string; name: string; type: string };
        workspace: { id: string; name: string; urlKey: string };
      }>("{ viewer { id name type } workspace { id name urlKey } }");
      setApiContext({
        workspaceId: data.workspace.id,
        workspaceName: data.workspace.name,
        workspaceUrlKey: data.workspace.urlKey,
        actorId: data.viewer.id,
        actorName: data.viewer.name,
        actorType: data.viewer.type,
      });
      setStatus(`Connected as ${data.viewer.name} (${data.viewer.type.toLowerCase()})`);
      setTimeout(() => {
        navigate("/");
        window.location.reload();
      }, 600);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Connection failed: ${message}. Check the key and try again.`);
    }
  }

  async function renameWorkspace() {
    const validation = validateWorkspaceName(workspaceName);
    if (validation) throw new Error(validation);
    const result = await mutate<{
      workspaceUpdate: { success: boolean; workspace: AdminData["workspace"] };
    }>(
      `mutation($input: WorkspaceUpdateInput!) {
        workspaceUpdate(input: $input) { success workspace { id name urlKey } }
      }`,
      { input: { name: workspaceName.trim() } },
    );
    setAdminData((current) =>
      current ? { ...current, workspace: result.workspaceUpdate.workspace } : current,
    );
    setWorkspaceName(result.workspaceUpdate.workspace.name);
    setWorkspaceRenameOpen(false);
    setStatus("Workspace name updated.");
  }

  async function runTeamAction() {
    if (!teamAction) return;
    const { kind, team } = teamAction;
    if (kind === "delete") {
      const result = await mutate<{ teamDelete: { success: boolean } }>(
        `mutation($id: ID!, $confirmation: String!) {
          teamDelete(id: $id, confirmation: $confirmation) { success }
        }`,
        { id: team.id, confirmation: team.key },
      );
      if (!result.teamDelete.success) throw new Error("The Team could not be deleted.");
    } else {
      const mutation = kind === "archive" ? "teamArchive" : "teamUnarchive";
      const result = await mutate<{ [key: string]: { success: boolean } }>(
        `mutation($id: ID!) { ${mutation}(id: $id) { success } }`,
        { id: team.id },
      );
      if (!result[mutation]?.success) throw new Error(`The Team could not be ${kind}d.`);
    }
    setTeamAction(null);
    await loadAdmin();
    setStatus(
      kind === "delete"
        ? `Team ${team.key} was permanently deleted.`
        : kind === "archive"
          ? `Team ${team.key} was archived.`
          : `Team ${team.key} was restored.`,
    );
  }

  return (
    <div className="settings" style={existingKey ? { maxWidth: 980 } : undefined}>
      <h2 style={{ margin: 0 }}>Settings</h2>
      <label>
        Theme
        <select
          value={theme}
          onChange={(event) => {
            if (isThemePreference(event.target.value)) changeTheme(event.target.value);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {!localAuth && (
        <>
          {onboardingConflict && (
            <div role="status" style={{ color: "var(--text-muted)" }}>
              <p style={{ margin: 0 }}>
                This link contains another API key. Your existing credential was not replaced.
              </p>
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setKey(onboardingKey);
                  setStatus("Onboarding key selected. Save & connect to confirm the change.");
                }}
              >
                Use onboarding key
              </button>
            </div>
          )}
          <label>
            API key
            <input
              value={key}
              placeholder="pb_..."
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && save()}
            />
          </label>
          <div>
            <button className="btn" onClick={save}>
              Save & connect
            </button>
          </div>
          <p style={{ color: "var(--text-faint)" }}>
            The key is stored in this browser only (localStorage) and sent as
            <code> Authorization: Bearer</code> to /graphql.
          </p>
        </>
      )}
      {status && <div style={{ color: "var(--text-muted)" }}>{status}</div>}

      {existingKey && (
        <section
          className="settings-panel"
          aria-labelledby="workspace-administration-title"
          style={{ maxWidth: 980 }}
        >
          <header className="settings-panel-header">
            <div>
              <h2 id="workspace-administration-title">Workspace administration</h2>
              <p>Manage the workspace identity and Team lifecycle.</p>
            </div>
            {adminData && <span className="settings-count">{isAdmin ? "Admin" : "Member"}</span>}
          </header>
          {adminLoading && !adminData && (
            <div className="settings-empty">Loading administration settings…</div>
          )}
          {adminError && (
            <div className="error-banner" role="alert">
              {adminError}
            </div>
          )}
          {adminData && !isAdmin && (
            <div className="settings-readonly-banner" role="status">
              Workspace renaming and Team lifecycle actions are available only to Workspace Admins.
            </div>
          )}
          {adminData && isAdmin && (
            <>
              <div className="settings-panel workspace-name-panel">
                <div className="settings-panel-header">
                  <div>
                    <h3>Workspace name</h3>
                    <p>
                      The name is visible to everyone. The URL key and Workspace identity stay
                      unchanged.
                    </p>
                  </div>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={Boolean(validateWorkspaceName(workspaceName))}
                    onClick={() => setWorkspaceRenameOpen(true)}
                  >
                    Rename workspace
                  </button>
                </div>
                <div className="workspace-identity-form">
                  <label>
                    Workspace name
                    <input
                      aria-label="Workspace name"
                      value={workspaceName}
                      aria-invalid={Boolean(validateWorkspaceName(workspaceName))}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                    />
                    {validateWorkspaceName(workspaceName) && (
                      <span role="alert" style={{ color: "var(--danger)", fontSize: 11 }}>
                        Workspace name cannot be empty.
                      </span>
                    )}
                  </label>
                  <span className="workspace-url-key">URL key: {adminData.workspace.urlKey}</span>
                </div>
              </div>
              <div className="settings-panel" aria-labelledby="team-lifecycle-title">
                <div className="settings-panel-header">
                  <div>
                    <h3 id="team-lifecycle-title">Teams</h3>
                    <p>Archive Teams to hide them from normal views, or restore them later.</p>
                  </div>
                  <span className="settings-count">{adminData.teams.length} total</span>
                </div>
                <div className="settings-list">
                  {adminData.teams.map((team) => {
                    const archived = Boolean(team.archivedAt);
                    return (
                      <div className="workspace-team-row" key={team.id}>
                        <div className="workspace-team-main">
                          <div className="workspace-team-heading">
                            <strong>{team.name}</strong>
                            <span
                              className={`workspace-team-status ${archived ? "archived" : "active"}`}
                            >
                              <span aria-hidden="true" className="workspace-team-status-dot" />
                              {archived ? "Archived" : "Active"}
                            </span>
                          </div>
                          <span className="workspace-team-key">{team.key}</span>
                          <small className="workspace-team-dependencies">
                            <span className="workspace-team-dependencies-label">
                              Deletion safeguards
                            </span>
                            {teamDeletionDependencyMessage(team)}
                          </small>
                        </div>
                        <div className="workspace-team-controls">
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() =>
                              setTeamAction({ team, kind: archived ? "restore" : "archive" })
                            }
                          >
                            {archived ? "Restore" : "Archive"}
                          </button>
                          <button
                            className="btn danger"
                            type="button"
                            onClick={() => setTeamAction({ team, kind: "delete" })}
                          >
                            Delete permanently
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {adminData.teams.length === 0 && (
                    <div className="settings-empty">No Teams found.</div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {workspaceRenameOpen && adminData && isAdmin && (
        <ConfirmModal
          title="Rename workspace"
          message={`Rename the workspace to “${workspaceName.trim() || "(empty)"}”? This changes the name shown to everyone, but not its URL key or identity.`}
          confirmLabel="Rename"
          onClose={() => setWorkspaceRenameOpen(false)}
          onConfirm={renameWorkspace}
        />
      )}
      {teamAction && (
        <ConfirmModal
          title={
            teamAction.kind === "delete"
              ? `Delete ${teamAction.team.name} permanently`
              : `${teamAction.kind === "archive" ? "Archive" : "Restore"} ${teamAction.team.name}`
          }
          message={
            teamAction.kind === "delete"
              ? `${teamDeletionDependencyMessage(teamAction.team)} This action is irreversible. Type the Team key ${teamAction.team.key} to confirm.`
              : teamAction.kind === "archive"
                ? `Archive Team ${teamAction.team.key}? Its issues and history are retained, but the Team leaves normal views until restored.`
                : `Restore Team ${teamAction.team.key}? It will return to normal Team views and accept new work again.`
          }
          confirmLabel={
            teamAction.kind === "delete"
              ? "Delete permanently"
              : teamAction.kind === "archive"
                ? "Archive"
                : "Restore"
          }
          confirmation={
            teamAction.kind === "delete"
              ? { label: `Type ${teamAction.team.key} to confirm`, expected: teamAction.team.key }
              : undefined
          }
          onClose={() => setTeamAction(null)}
          onConfirm={runTeamAction}
        />
      )}
    </div>
  );
}
