// Router por hash: #/team/PB, #/board/PB, #/issue/PB-1, #/project/<id>,
// #/project-board/<id>, #/settings.
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";

export function useRoute(): string[] {
  const parse = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState<string[]>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith("/") ? `#${path}` : `#/${path}`;
}

export function Link(props: {
  to: string;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  role?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={props.className}
      style={props.style}
      onClick={props.onClick}
      role={props.role}
      href={`#${props.to.startsWith("/") ? props.to : `/${props.to}`}`}
    >
      {props.children}
    </a>
  );
}
