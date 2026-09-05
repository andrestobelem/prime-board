import { describe, expect, test } from "bun:test";
import { getRetiredRouteResponse, RETIRED_ROUTE_MESSAGE } from "../src/retired-routes.ts";

describe("retired document routes", () => {
  test("returns the same 404 response for collection and item bookmarks", () => {
    expect(getRetiredRouteResponse(["documents"])).toEqual({
      status: 404,
      message: RETIRED_ROUTE_MESSAGE,
    });
    expect(getRetiredRouteResponse(["document", "legacy-id"])).toEqual({
      status: 404,
      message: RETIRED_ROUTE_MESSAGE,
    });
  });

  test("does not classify supported routes as retired", () => {
    expect(getRetiredRouteResponse(["projects"])).toBeNull();
    expect(getRetiredRouteResponse(["issue", "PRB-1"])).toBeNull();
  });
});
