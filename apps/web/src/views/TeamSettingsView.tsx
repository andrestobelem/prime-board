// Configuración del team: estados del workflow y labels.
import { useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { LabelChip, StateIcon } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { ConfirmModal } from "../components/EntityModal.tsx";

const QUERY = `query($key: String) {
  viewer { id workspaceRole }
  team(key: $key) {
    id key name
    defaultState { id }
    states { id name type color position }
    labels { id name color teamId }
    memberships { actor { id } role }
  }
}`;

const STATE_TYPES = ["TRIAGE", "BACKLOG", "UNSTARTED", "STARTED", "COMPLETED", "CANCELED"];

type DeleteTarget = { id: string; kind: "state" | "label"; name: string };

export function TeamSettingsView({ teamKey }: { teamKey: string }) {
  const result = useQuery<any>(QUERY, { key: teamKey });
  const [stateName, setStateName] = useState("");
  const [stateType, setStateType] = useState("UNSTARTED");
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("#95a2b3");
  const [labelScope, setLabelScope] = useState("team");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  const team = result.data?.team;
  if (!team) return <div className="empty">Team {teamKey} not found.</div>;
  const viewer = result.data?.viewer;
  const canManage =
    viewer?.workspaceRole === "ADMIN" ||
    team.memberships.some(
      (membership: any) => membership.actor.id === viewer?.id && membership.role === "OWNER",
    );

  async function runMutation(key: string, operation: () => Promise<unknown>): Promise<boolean> {
    setSaving(key);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this change.");
      return false;
    } finally {
      setSaving(null);
    }
  }

  async function createState(): Promise<void> {
    if (!stateName.trim()) return;
    const created = await runMutation("new-state", () =>
      mutate(
        `mutation($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) { success }
      }`,
        { input: { teamId: team.id, name: stateName.trim(), type: stateType } },
      ),
    );
    if (created) setStateName("");
  }

  async function updateState(id: string, input: Record<string, unknown>): Promise<void> {
    await runMutation(`state-${id}`, () =>
      mutate(
        `mutation($id: ID!, $input: WorkflowStateUpdateInput!) {
        workflowStateUpdate(id: $id, input: $input) { success }
      }`,
        { id, input },
      ),
    );
  }

  async function moveState(index: number, delta: number): Promise<void> {
    const states = [...team.states];
    const target = states[index + delta];
    const current = states[index];
    if (!target || !current) return;
    await runMutation(`state-${current.id}`, async () => {
      await mutate(
        `mutation($id: ID!, $input: WorkflowStateUpdateInput!) {
        workflowStateUpdate(id: $id, input: $input) { success }
      }`,
        { id: current.id, input: { position: target.position } },
      );
      await mutate(
        `mutation($id: ID!, $input: WorkflowStateUpdateInput!) {
        workflowStateUpdate(id: $id, input: $input) { success }
      }`,
        { id: target.id, input: { position: current.position } },
      );
    });
  }

  async function deleteState(): Promise<void> {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const other = team.states.find((candidate: any) => candidate.id !== target.id);
    const deleted = await runMutation(`state-${target.id}`, () =>
      mutate(
        `mutation($id: ID!, $to: ID) {
        workflowStateDelete(id: $id, moveToStateId: $to) { movedIssues }
      }`,
        { id: target.id, to: other?.id ?? null },
      ),
    );
    if (deleted) setDeleteTarget(null);
  }

  async function createLabel(): Promise<void> {
    if (!labelName.trim()) return;
    const created = await runMutation("new-label", () =>
      mutate(`mutation($input: LabelCreateInput!) { labelCreate(input: $input) { success } }`, {
        input: {
          name: labelName.trim(),
          color: labelColor,
          teamId: labelScope === "team" ? team.id : null,
        },
      }),
    );
    if (created) setLabelName("");
  }

  async function updateLabel(id: string, input: Record<string, unknown>): Promise<void> {
    await runMutation(`label-${id}`, () =>
      mutate(
        `mutation($id: ID!, $input: LabelUpdateInput!) {
        labelUpdate(id: $id, input: $input) { success }
      }`,
        { id, input },
      ),
    );
  }

  async function deleteLabel(): Promise<void> {
    if (!deleteTarget) return;
    const deleted = await runMutation(`label-${deleteTarget.id}`, () =>
      mutate(`mutation($id: ID!) { labelDelete(id: $id) { affectedIssues } }`, {
        id: deleteTarget.id,
      }),
    );
    if (deleted) setDeleteTarget(null);
  }

  return (
    <div className="team-settings-page">
      <header className="settings-page-header">
        <div>
          <span className="settings-eyebrow">{team.key}</span>
          <h1>Team settings</h1>
          <p>Configure the workflow and labels used by this team.</p>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {!canManage && (
        <div className="settings-readonly-banner" role="status">
          You can view these settings, but only a team owner or workspace admin can edit them.
        </div>
      )}

      <section className="settings-panel" aria-labelledby="workflow-states-title">
        <div className="settings-panel-header">
          <div>
            <h2 id="workflow-states-title">Workflow states</h2>
            <p>Define the path issues take from triage to completion.</p>
          </div>
          <span className="settings-count">{team.states.length} states</span>
        </div>
        <div className="settings-list">
          {team.states.length === 0 && (
            <div className="settings-empty">No workflow states yet. Add the first state below.</div>
          )}
          {team.states.map((state: any, index: number) => {
            const stateSaving = saving === `state-${state.id}`;
            return (
              <div className="team-setting-row" key={state.id} aria-busy={stateSaving}>
                <div className="team-setting-identity">
                  <StateIcon state={state} />
                  <div>
                    <input
                      className="settings-name-input"
                      aria-label={`Name for ${state.name}`}
                      defaultValue={state.name}
                      disabled={!canManage || stateSaving}
                      onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next && next !== state.name) void updateState(state.id, { name: next });
                      }}
                    />
                    <span className="settings-row-meta">
                      {state.type.toLowerCase()}
                      {state.id === team.defaultState.id && (
                        <span className="default-badge">Default</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="team-setting-controls">
                  <select
                    aria-label={`Type for ${state.name}`}
                    value={state.type}
                    disabled={!canManage || stateSaving}
                    onChange={(event) => void updateState(state.id, { type: event.target.value })}
                  >
                    {STATE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <input
                    className="state-color-input"
                    aria-label={`Color for ${state.name}`}
                    type="color"
                    value={state.color}
                    disabled={!canManage || stateSaving}
                    onChange={(event) => void updateState(state.id, { color: event.target.value })}
                  />
                  {canManage && state.id !== team.defaultState.id && (
                    <button
                      className="btn secondary compact"
                      disabled={!canManage || stateSaving}
                      onClick={() =>
                        void runMutation(`state-${state.id}`, () =>
                          mutate(
                            `mutation($id: ID!, $input: TeamUpdateInput!) {
                          teamUpdate(id: $id, input: $input) { success }
                        }`,
                            { id: team.id, input: { defaultStateId: state.id } },
                          ),
                        )
                      }
                    >
                      Set default
                    </button>
                  )}
                  <button
                    className="icon-action danger"
                    aria-label={`Delete ${state.name}`}
                    title="Delete state"
                    disabled={!canManage || stateSaving}
                    onClick={() =>
                      setDeleteTarget({ id: state.id, kind: "state", name: state.name })
                    }
                  >
                    <Icon name="x" size={14} />
                  </button>
                  <button
                    className="icon-action"
                    aria-label={`Move ${state.name} up`}
                    title="Move up"
                    disabled={!canManage || stateSaving || index === 0}
                    onClick={() => void moveState(index, -1)}
                  >
                    <Icon name="arrow-up" size={14} />
                  </button>
                  <button
                    className="icon-action"
                    aria-label={`Move ${state.name} down`}
                    title="Move down"
                    disabled={!canManage || stateSaving || index === team.states.length - 1}
                    onClick={() => void moveState(index, 1)}
                  >
                    <Icon name="arrow-down" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {canManage && (
          <form
            className="settings-add-row"
            onSubmit={(event) => {
              event.preventDefault();
              void createState();
            }}
          >
            <input
              aria-label="New state name"
              placeholder="New state"
              value={stateName}
              disabled={saving === "new-state"}
              onChange={(event) => setStateName(event.target.value)}
            />
            <select
              aria-label="New state type"
              value={stateType}
              onChange={(event) => setStateType(event.target.value)}
            >
              {STATE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toLowerCase()}
                </option>
              ))}
            </select>
            <button
              className="btn"
              type="submit"
              disabled={!stateName.trim() || saving === "new-state"}
            >
              <Icon name="plus" size={14} /> Add state
            </button>
          </form>
        )}
      </section>

      <section className="settings-panel" aria-labelledby="labels-title">
        <div className="settings-panel-header">
          <div>
            <h2 id="labels-title">Labels</h2>
            <p>Use labels to route and describe work across the board.</p>
          </div>
          <span className="settings-count">{team.labels.length} labels</span>
        </div>
        <div className="settings-list">
          {team.labels.length === 0 && (
            <div className="settings-empty">
              No labels yet. Add one below to make issues easier to route.
            </div>
          )}
          {team.labels.map((label: any) => {
            const labelSaving = saving === `label-${label.id}`;
            return (
              <div className="team-setting-row" key={label.id} aria-busy={labelSaving}>
                <div className="team-setting-identity">
                  <LabelChip label={label} />
                  <span className="settings-row-meta">{label.teamId ? "team" : "workspace"}</span>
                </div>
                <div className="team-setting-controls">
                  <input
                    className="settings-name-input"
                    aria-label={`Name for ${label.name}`}
                    defaultValue={label.name}
                    disabled={!canManage || labelSaving}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next && next !== label.name) void updateLabel(label.id, { name: next });
                    }}
                  />
                  <input
                    className="state-color-input"
                    aria-label={`Color for ${label.name}`}
                    type="color"
                    value={label.color}
                    disabled={!canManage || labelSaving}
                    onChange={(event) => void updateLabel(label.id, { color: event.target.value })}
                  />
                  <button
                    className="icon-action danger"
                    aria-label={`Delete ${label.name}`}
                    title="Delete label"
                    disabled={!canManage || labelSaving}
                    onClick={() =>
                      setDeleteTarget({ id: label.id, kind: "label", name: label.name })
                    }
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {canManage && (
          <form
            className="settings-add-row"
            onSubmit={(event) => {
              event.preventDefault();
              void createLabel();
            }}
          >
            <input
              aria-label="New label name"
              placeholder="New label"
              value={labelName}
              disabled={saving === "new-label"}
              onChange={(event) => setLabelName(event.target.value)}
            />
            <input
              className="state-color-input"
              aria-label="New label color"
              type="color"
              value={labelColor}
              disabled={saving === "new-label"}
              onChange={(event) => setLabelColor(event.target.value)}
            />
            <select
              aria-label="New label scope"
              value={labelScope}
              onChange={(event) => setLabelScope(event.target.value)}
            >
              <option value="team">team</option>
              <option value="workspace">workspace</option>
            </select>
            <button
              className="btn"
              type="submit"
              disabled={!labelName.trim() || saving === "new-label"}
            >
              <Icon name="plus" size={14} /> Add label
            </button>
          </form>
        )}
      </section>

      {deleteTarget && (
        <ConfirmModal
          title={`Delete ${deleteTarget.kind}`}
          message={
            deleteTarget.kind === "state"
              ? `Delete “${deleteTarget.name}”? Issues in this state will be moved to another state.`
              : `Delete “${deleteTarget.name}”? It will be removed from issues using it.`
          }
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => (deleteTarget.kind === "state" ? deleteState() : deleteLabel())}
        />
      )}
    </div>
  );
}
