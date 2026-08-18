// Deriva la navegación por scope sin duplicar proyectos multi-team (PRB-269).
export interface NavigationProject {
  id: string;
  name: string;
  state: string;
}

export interface NavigationView {
  id: string;
  name: string;
  scope: string;
  team: { id: string; key: string } | null;
}

export interface NavigationTeam {
  id: string;
  projects: NavigationProject[];
  views: NavigationView[];
}

export interface NavigationModel {
  projects: NavigationProject[];
  workspaceViews: NavigationView[];
  teams: NavigationTeam[];
}

/**
 * La API ya filtra las vistas visibles para el viewer. Este derivador solo las
 * coloca bajo su scope y mantiene un único objeto por proyecto para el índice
 * global, aunque el proyecto esté asociado a varios teams.
 */
export function buildNavigation(
  teams: Array<{ id: string; projects: NavigationProject[] }>,
  views: NavigationView[],
): NavigationModel {
  const projects = new Map<string, NavigationProject>();
  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) projects.set(project.id, project);
    }
  }

  const workspaceViews = views.filter((view) => view.scope.toUpperCase() !== "TEAM");
  const teamViews = new Map<string, NavigationView[]>();
  for (const view of views) {
    if (view.scope.toUpperCase() !== "TEAM" || !view.team) continue;
    const scoped = teamViews.get(view.team.id) ?? [];
    scoped.push(view);
    teamViews.set(view.team.id, scoped);
  }

  return {
    projects: [...projects.values()],
    workspaceViews,
    teams: teams.map((team) => ({
      id: team.id,
      projects: team.projects,
      views: teamViews.get(team.id) ?? [],
    })),
  };
}

export interface RouteTeamContext {
  key: string;
  projects?: Array<{ id: string }>;
  cycles?: Array<{ id: string }>;
}

/** Ruta predeterminada al abrir un team: el board, no la lista. */
export function getDefaultTeamPath(teamKey: string): string {
  return `/board/${teamKey}`;
}

/** Returns the team represented by the current route for creation flows. */
export function getTeamKeyForRoute(route: string[], teams: RouteTeamContext[]): string | undefined {
  const [section, param] = route;
  if (!param) return teams[0]?.key;
  if (["team", "board", "triage", "team-settings"].includes(section ?? "")) return param;
  if (section === "issue") return param.split("-")[0];
  if (section === "cycle") {
    return (
      teams.find((team) => team.cycles?.some((cycle) => cycle.id === param))?.key ?? teams[0]?.key
    );
  }
  if (section === "project" || section === "project-board") {
    return (
      teams.find((team) => team.projects?.some((project) => project.id === param))?.key ??
      teams[0]?.key
    );
  }
  return teams[0]?.key;
}
