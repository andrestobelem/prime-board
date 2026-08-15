// Piezas visuales chicas: prioridad, estado, avatar, label (estética Linear).
import { Icon, type IconName } from "./icons.tsx";

export const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

/** Ícono por nivel de prioridad, en el orden de la API (0 = sin prioridad). */
const PRIORITY_ICONS: IconName[] = [
  "priority-none",
  "priority-urgent",
  "priority-high",
  "priority-medium",
  "priority-low",
];

export function PriorityIcon({ priority }: { priority: number }) {
  const name = PRIORITY_ICONS[priority] ?? "priority-none";
  const label = PRIORITY_NAMES[priority] ?? "No priority";
  // Urgent es el único que se destaca con color; el resto queda en el gris del texto.
  return (
    <Icon
      name={name}
      className={`priority-icon${priority === 1 ? " urgent" : ""}`}
      title={label}
    />
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

/** Ícono por tipo de estado del workflow. */
const STATE_ICONS: Record<string, IconName> = {
  TRIAGE: "state-triage",
  BACKLOG: "state-backlog",
  UNSTARTED: "state-todo",
  STARTED: "state-in-progress",
  COMPLETED: "state-done",
  CANCELED: "state-canceled",
};

/**
 * Ícono de estado: hereda el color del tipo vía `currentColor`, así que el
 * relleno del "en progreso" y el trazo del resto salen del mismo valor.
 */
export function StateIcon({ state }: { state: { type: string; color?: string; name?: string } }) {
  const color = STATE_COLORS[state.type] ?? "#8a8f98";
  return (
    <span className="state-icon" style={{ color }}>
      <Icon name={STATE_ICONS[state.type] ?? "state-todo"} title={state.name} />
    </span>
  );
}

export function Avatar({ actor }: { actor: { name: string; type: string } | null }) {
  if (!actor) return <span className="avatar" title="Unassigned">–</span>;
  const isAgent = actor.type === "AGENT";
  const initials = actor.name.slice(0, 2).toUpperCase();
  return (
    <span className={`avatar${isAgent ? " agent" : ""}`} title={`${actor.name}${isAgent ? " (agent)" : ""}`}>
      {isAgent ? <Icon name="bot" size={11} /> : initials}
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
