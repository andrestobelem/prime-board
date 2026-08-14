// Piezas visuales chicas: prioridad, estado, avatar, label (estética Linear).
export const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

export function PriorityIcon({ priority }: { priority: number }) {
  if (priority === 1) return <span className="priority-icon urgent" title="Urgent">!</span>;
  const active = (bar: number) =>
    priority !== 0 && bar <= 4 - priority ? "active" : "";
  // High: 3 barras activas, Medium: 2, Low: 1 (visual tipo Linear).
  const bars = priority === 0 ? 0 : 5 - priority; // 2→3, 3→2, 4→1
  return (
    <span className="priority-icon" title={PRIORITY_NAMES[priority]}>
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`b${bar}`}
          style={{ background: bar <= bars ? "var(--text-muted)" : "var(--border)" }}
        />
      ))}
    </span>
  );
}

const STATE_COLORS: Record<string, string> = {
  TRIAGE: "#fc7840",
  BACKLOG: "#5c6067",
  UNSTARTED: "#8a8f98",
  STARTED: "#f2c94c",
  COMPLETED: "#5e6ad2",
  CANCELED: "#5c6067",
};

export function StateDot({ state }: { state: { type: string; color?: string; name?: string } }) {
  const color = STATE_COLORS[state.type] ?? "#8a8f98";
  return (
    <span
      className="state-dot"
      title={state.name}
      style={{
        borderColor: color,
        background: state.type === "COMPLETED" || state.type === "CANCELED" ? color : "transparent",
      }}
    />
  );
}

export function Avatar({ actor }: { actor: { name: string; type: string } | null }) {
  if (!actor) return <span className="avatar" title="Unassigned">–</span>;
  const isAgent = actor.type === "AGENT";
  const initials = actor.name.slice(0, 2).toUpperCase();
  return (
    <span className={`avatar${isAgent ? " agent" : ""}`} title={`${actor.name}${isAgent ? " 🤖" : ""}`}>
      {isAgent ? "🤖" : initials}
    </span>
  );
}

export function LabelChip({ label }: { label: { name: string; color: string } }) {
  return (
    <span className="label-chip">
      <span className="dot" style={{ background: label.color }} />
      {label.name}
    </span>
  );
}
