// Administración de estados y labels del team (AT-31).
import { useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { LabelChip, StateIcon } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";

const QUERY = `query($key: String) {
  team(key: $key) {
    id key name
    defaultState { id }
    states { id name type color position }
    labels { id name color teamId }
  }
}`;

const STATE_TYPES = ["TRIAGE", "BACKLOG", "UNSTARTED", "STARTED", "COMPLETED", "CANCELED"];

export function TeamSettingsView({ teamKey }: { teamKey: string }) {
  const result = useQuery<any>(QUERY, { key: teamKey });
  const [stateName, setStateName] = useState("");
  const [stateType, setStateType] = useState("UNSTARTED");
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("#95a2b3");
  const [labelScope, setLabelScope] = useState("team");

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  const team = result.data?.team;
  if (!team) return <div className="empty">Team {teamKey} not found.</div>;

  const createState = async () => {
    if (!stateName.trim()) return;
    await mutate(`mutation($input: WorkflowStateCreateInput!) {
      workflowStateCreate(input: $input) { success }
    }`, { input: { teamId: team.id, name: stateName.trim(), type: stateType } });
    setStateName("");
  };

  const updateState = (id: string, input: Record<string, unknown>) =>
    mutate(`mutation($id: ID!, $input: WorkflowStateUpdateInput!) {
      workflowStateUpdate(id: $id, input: $input) { success }
    }`, { id, input });

  // Reordenar = intercambiar posiciones con el vecino.
  const move = async (index: number, delta: number) => {
    const states = [...team.states];
    const target = states[index + delta];
    const current = states[index];
    if (!target || !current) return;
    await updateState(current.id, { position: target.position });
    await updateState(target.id, { position: current.position });
  };

  return (
    <div style={{ padding: 24, maxWidth: 760, display: "flex", flexDirection: "column", gap: 28 }}>
      <div>
        <h3 style={{ margin: "0 0 10px" }}>Workflow states</h3>
        {team.states.map((state: any, index: number) => (
          <div key={state.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
            <StateIcon state={state} />
            <input
              defaultValue={state.name}
              onBlur={(event) =>
                event.target.value !== state.name && updateState(state.id, { name: event.target.value })
              }
              style={{ width: 200 }}
            />
            <select value={state.type} onChange={(event) => updateState(state.id, { type: event.target.value })}>
              {STATE_TYPES.map((type) => <option key={type} value={type}>{type.toLowerCase()}</option>)}
            </select>
            <input
              type="color"
              defaultValue={state.color}
              onBlur={(event) => updateState(state.id, { color: event.target.value })}
              style={{ width: 42, padding: 2 }}
            />
            <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
              {state.id === team.defaultState.id ? (
                <span
                  title="New issues without an explicit state land here"
                  style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)",
                           borderRadius: 4, padding: "1px 6px", marginRight: 6 }}
                >
                  Default
                </span>
              ) : (
                <button
                  className="btn secondary"
                  title="Make this the default state for new issues"
                  style={{ fontSize: 11, marginRight: 6 }}
                  onClick={() =>
                    mutate(`mutation($id: ID!, $input: TeamUpdateInput!) {
                      teamUpdate(id: $id, input: $input) { success }
                    }`, { id: team.id, input: { defaultStateId: state.id } })
                  }
                >
                  Set default
                </button>
              )}
              <button
                style={{ color: "var(--danger)", marginRight: 6 }}
                title="Borrar estado (migra sus issues)"
                onClick={async () => {
                  // El destino se pide solo si hace falta: la API lo exige cuando hay issues.
                  const others = team.states.filter((candidate: any) => candidate.id !== state.id);
                  const target = others[0];
                  try {
                    await mutate(`mutation($id: ID!, $to: ID) {
                      workflowStateDelete(id: $id, moveToStateId: $to) { movedIssues }
                    }`, { id: state.id, to: target?.id ?? null });
                  } catch (error) {
                    window.alert(String(error));
                  }
                }}
              >
                Delete
              </button>
              <button className="btn secondary" disabled={index === 0} onClick={() => move(index, -1)}>
                <Icon name="arrow-up" size={14} title="Move up" />
              </button>
              <button
                className="btn secondary"
                disabled={index === team.states.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icon name="arrow-down" size={14} title="Move down" />
              </button>
            </span>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            placeholder="Nuevo estado"
            value={stateName}
            onChange={(event) => setStateName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && createState()}
          />
          <select value={stateType} onChange={(event) => setStateType(event.target.value)}>
            {STATE_TYPES.map((type) => <option key={type} value={type}>{type.toLowerCase()}</option>)}
          </select>
          <button className="btn" onClick={createState}>Add state</button>
        </div>
      </div>

      <div>
        <h3 style={{ margin: "0 0 10px" }}>Labels</h3>
        {team.labels.map((label: any) => (
          <div key={label.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
            <LabelChip label={label} />
            <input
              defaultValue={label.name}
              onBlur={(event) =>
                event.target.value !== label.name &&
                mutate(`mutation($id: ID!, $input: LabelUpdateInput!) { labelUpdate(id: $id, input: $input) { success } }`,
                  { id: label.id, input: { name: event.target.value } })
              }
              style={{ width: 200 }}
            />
            <input
              type="color"
              defaultValue={label.color}
              onBlur={(event) =>
                mutate(`mutation($id: ID!, $input: LabelUpdateInput!) { labelUpdate(id: $id, input: $input) { success } }`,
                  { id: label.id, input: { color: event.target.value } })
              }
              style={{ width: 42, padding: 2 }}
            />
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
              {label.teamId ? "team" : "workspace"}
            </span>
            <button
              style={{ marginLeft: "auto", color: "var(--danger)" }}
              onClick={() =>
                mutate(`mutation($id: ID!) { labelDelete(id: $id) { affectedIssues } }`, { id: label.id })
              }
            >
              Delete
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            placeholder="Nueva label"
            value={labelName}
            onChange={(event) => setLabelName(event.target.value)}
          />
          <input
            type="color"
            value={labelColor}
            onChange={(event) => setLabelColor(event.target.value)}
            style={{ width: 42, padding: 2 }}
          />
          <select value={labelScope} onChange={(event) => setLabelScope(event.target.value)}>
            <option value="team">team</option>
            <option value="workspace">workspace</option>
          </select>
          <button
            className="btn"
            onClick={async () => {
              if (!labelName.trim()) return;
              await mutate(`mutation($input: LabelCreateInput!) { labelCreate(input: $input) { success } }`, {
                input: {
                  name: labelName.trim(),
                  color: labelColor,
                  teamId: labelScope === "team" ? team.id : null,
                },
              });
              setLabelName("");
            }}
          >
            Add label
          </button>
        </div>
      </div>
    </div>
  );
}
