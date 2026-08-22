// Router por hash. Las rutas legacy siguen funcionando; cuando el servidor soporta
// varios Workspaces se puede anteponer `workspace/<urlKey>` a cualquier deep-link.
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";

export interface ParsedRoute {
  workspaceKey?: string;
  segments: string[];
}

export function parseRoute(hash: string): ParsedRoute {
  const segments = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() !== "workspace") return { segments };
  const workspaceKey = segments[1];
  if (!workspaceKey) return { segments };
  return { workspaceKey: decodeURIComponent(workspaceKey), segments: segments.slice(2) };
}

export function getWorkspaceKeyFromHash(hash: string = window.location.hash): string | undefined {
  return parseRoute(hash).workspaceKey;
}

export function workspacePath(workspaceKey: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (
    normalized === `/workspace/${workspaceKey}` ||
    normalized.startsWith(`/workspace/${workspaceKey}/`)
  ) {
    return normalized;
  }
  return `/workspace/${encodeURIComponent(workspaceKey)}${normalized}`;
}

function preserveWorkspace(path: string): string {
  const workspaceKey = getWorkspaceKeyFromHash();
  return workspaceKey && !path.startsWith("/workspace/") ? workspacePath(workspaceKey, path) : path;
}

export function useRoute(): string[] {
  const parse = () => parseRoute(window.location.hash).segments;
  const [route, setRoute] = useState<string[]>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  const target = preserveWorkspace(path);
  window.location.hash = target.startsWith("/") ? `#${target}` : `#/${target}`;
}

export function Link(props: {
  to: string;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  role?: string;
  children: ReactNode;
}) {
  const target = preserveWorkspace(props.to);
  return (
    <a
      className={props.className}
      style={props.style}
      onClick={props.onClick}
      role={props.role}
      href={`#${target.startsWith("/") ? target : `/${target}`}`}
    >
      {props.children}
    </a>
  );
}
