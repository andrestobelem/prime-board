export const RETIRED_ROUTE_MESSAGE = "404 — This route is no longer available.";

export interface RetiredRouteResponse {
  status: 404;
  message: string;
}

/** Return the stable response for routes kept only for old bookmarks. */
export function getRetiredRouteResponse(route: readonly string[]): RetiredRouteResponse | null {
  const section = route[0]?.toLowerCase();
  if (section !== "documents" && section !== "document") return null;
  return { status: 404, message: RETIRED_ROUTE_MESSAGE };
}
