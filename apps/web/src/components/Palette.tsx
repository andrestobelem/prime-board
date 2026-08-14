// Command palette (⌘K) — AT-148: navegar, crear y buscar issues full-text.
import { useEffect, useRef, useState } from "react";
import { gql } from "../api.ts";
import { navigate } from "../router.tsx";
import { setThemePreference } from "../theme.ts";
import type { ShellData } from "../App.tsx";

interface PaletteItem {
  id: string;
  label: string;
  kind: string;
  run: () => void;
}

interface PaletteProps {
  shell: ShellData;
  onClose: () => void;
  onNewIssue: () => void;
}

export function Palette({ shell, onClose, onNewIssue }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [searchResults, setSearchResults] = useState<PaletteItem[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commands: PaletteItem[] = [
    {
      id: "new-issue",
      label: "New issue",
      kind: "action",
      run: () => { onClose(); onNewIssue(); },
    },
    ...shell.teams.flatMap((team) => [
      {
        id: `team-${team.id}`,
        label: `Go to team ${team.name} — list`,
        kind: "navigate",
        run: () => { onClose(); navigate(`/team/${team.key}`); },
      },
      {
        id: `board-${team.id}`,
        label: `Go to team ${team.name} — board`,
        kind: "navigate",
        run: () => { onClose(); navigate(`/board/${team.key}`); },
      },
    ]),
    ...shell.projects.map((project) => ({
      id: `project-${project.id}`,
      label: `Go to project ${project.name}`,
      kind: "navigate",
      run: () => { onClose(); navigate(`/project/${project.id}`); },
    })),
    {
      id: "settings",
      label: "Open settings",
      kind: "navigate",
      run: () => { onClose(); navigate("/settings"); },
    },
    ...(["dark", "light", "system"] as const).map((mode) => ({
      id: `theme-${mode}`,
      label: `Theme: ${mode[0]!.toUpperCase()}${mode.slice(1)}`,
      kind: "theme",
      run: () => { setThemePreference(mode); onClose(); },
    })),
  ];

  const lower = query.trim().toLowerCase();
  const filtered = lower
    ? commands.filter((command) => command.label.toLowerCase().includes(lower))
    : commands;
  const items = [...filtered, ...searchResults];

  // Búsqueda full-text de issues mientras se tipea.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!lower || lower.length < 2) {
      setSearchResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const data = await gql<{ issues: { nodes: Array<{ identifier: string; title: string }> } }>(
          `query($search: String) {
            issues(filter: { search: $search }, first: 8) { nodes { identifier title } }
          }`, { search: lower });
        setSearchResults(data.issues.nodes.map((issue) => ({
          id: `issue-${issue.identifier}`,
          label: `${issue.identifier} ${issue.title}`,
          kind: "issue",
          run: () => { onClose(); navigate(`/issue/${issue.identifier}`); },
        })));
      } catch {
        setSearchResults([]);
      }
    }, 140);
  }, [lower, onClose]);

  useEffect(() => setSelected(0), [query, searchResults.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal">
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command or search issues…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((index) => Math.min(index + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              items[selected]?.run();
            }
          }}
        />
        <div className="palette-list">
          {items.map((item, index) => (
            <button
              key={item.id}
              className={`palette-item${index === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => item.run()}
            >
              {item.label}
              <span className="kind">{item.kind}</span>
            </button>
          ))}
          {items.length === 0 && <div className="empty">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
