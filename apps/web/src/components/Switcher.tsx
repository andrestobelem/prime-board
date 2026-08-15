// Switcher de contexto en el topbar (AT-170): saltar entre teams y sus proyectos.
// Un team puede tener varios proyectos, y `Project.teams` es una lista, así que
// un mismo proyecto puede aparecer bajo más de un team.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../router.tsx";
import { Icon } from "./icons.tsx";

export interface SwitcherTeam {
  id: string;
  key: string;
  name: string;
  projects: Array<{ id: string; name: string; state: string }>;
}

export type SwitcherTarget =
  | { kind: "team"; key: string }
  | { kind: "project"; id: string };

interface SwitcherProps {
  teams: SwitcherTeam[];
  current: SwitcherTarget;
  /** Vista activa; se preserva al saltar de team (board → board, list → list). */
  view: "team" | "board";
}

const CLOSED_STATES = ["COMPLETED", "CANCELED"];

interface Entry {
  id: string;
  teamKey: string;
  label: string;
  kind: "team" | "project";
  closed: boolean;
  active: boolean;
  go: () => void;
}

export function Switcher({ teams, current, view }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const rows: Entry[] = [];
    for (const team of teams) {
      rows.push({
        id: `team-${team.id}`,
        teamKey: team.key,
        label: `${team.name} — issues`,
        kind: "team",
        closed: false,
        active: current.kind === "team" && current.key === team.key,
        go: () => navigate(`/${view}/${team.key}`),
      });
      const projects = [...team.projects].sort(
        (a, b) => Number(CLOSED_STATES.includes(a.state)) - Number(CLOSED_STATES.includes(b.state)),
      );
      for (const project of projects) {
        rows.push({
          id: `project-${team.id}-${project.id}`,
          teamKey: team.key,
          label: project.name,
          kind: "project",
          closed: CLOSED_STATES.includes(project.state),
          active: current.kind === "project" && current.id === project.id,
          // La vista elegida se preserva también al saltar de proyecto (AT-182).
          go: () => navigate(view === "board" ? `/project-board/${project.id}` : `/project/${project.id}`),
        });
      }
    }
    return rows;
  }, [teams, current, view]);

  const lower = query.trim().toLowerCase();
  const visible = lower
    ? entries.filter((entry) =>
        `${entry.label} ${entry.teamKey}`.toLowerCase().includes(lower))
    : entries;

  const label =
    current.kind === "team"
      ? teams.find((team) => team.key === current.key)?.name ?? current.key
      : teams.flatMap((team) => team.projects).find((p) => p.id === current.id)?.name ?? "Project";

  useEffect(() => setSelected(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    entry.go();
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="switcher" ref={root}>
      <button
        className="switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="title">{label}</span>
        <Icon name="chevron-down" size={14} className="caret" />
      </button>
      {open && (
        <div className="switcher-menu" role="menu">
          <input
            className="switcher-input"
            autoFocus
            placeholder="Switch team or project…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, visible.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(visible[selected]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="switcher-list">
            {visible.length === 0 && <div className="switcher-empty">No matches.</div>}
            {visible.map((entry, index) => (
              <button
                key={entry.id}
                className={`switcher-item ${entry.kind}${index === selected ? " selected" : ""}${entry.active ? " active" : ""}${entry.closed ? " closed" : ""}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(entry)}
              >
                <Icon name={entry.kind === "team" ? "team-key" : "project"} className="glyph" />
                <span className="switcher-label">{entry.label}</span>
                {entry.kind === "project" && <span className="team-key">{entry.teamKey}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
