// PRB-208: duplicar, archivar y columnas visibles en vistas guardadas.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("saved views extras", () => {
  it("duplica una vista con columnas y permite archivarla", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id;

    const created = await gql(
      app,
      `
      mutation($input: SavedViewCreateInput!) {
        savedViewCreate(input: $input) {
          savedView { id name columns archivedAt }
        }
      }
    `,
      {
        input: {
          name: "Bugs",
          scope: "TEAM",
          teamId,
          filter: { priority: { eq: 1 } },
          columns: ["identifier", "title", "priority", "assignee"],
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const original = created.data!.savedViewCreate.savedView;
    expect(original.columns).toEqual(["identifier", "title", "priority", "assignee"]);
    expect(original.archivedAt).toBeNull();

    const duplicated = await gql(
      app,
      `mutation($id: ID!) {
        savedViewDuplicate(id: $id) {
          savedView { id name columns filter scope }
        }
      }`,
      { id: original.id },
    );
    expect(duplicated.errors).toBeUndefined();
    const copy = duplicated.data!.savedViewDuplicate.savedView;
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Bugs (copy)");
    expect(copy.columns).toEqual(original.columns);
    expect(copy.filter).toEqual({ priority: { eq: 1 } });
    expect(copy.scope).toBe("TEAM");

    const archived = await gql(
      app,
      `mutation($id: ID!) {
        savedViewUpdate(id: $id, input: { archived: true }) {
          savedView { id archivedAt }
        }
      }`,
      { id: original.id },
    );
    expect(archived.data!.savedViewUpdate.savedView.archivedAt).toBeTruthy();

    const listed = await gql(
      app,
      `query($teamId: ID!) { savedViews(teamId: $teamId) { id name } }`,
      { teamId },
    );
    expect(listed.data!.savedViews.some((v: { id: string }) => v.id === original.id)).toBe(false);
    expect(listed.data!.savedViews.some((v: { id: string }) => v.id === copy.id)).toBe(true);

    const withArchived = await gql(
      app,
      `query($teamId: ID!) {
        savedViews(teamId: $teamId, includeArchived: true) { id archivedAt }
      }`,
      { teamId },
    );
    expect(
      withArchived.data!.savedViews.some(
        (v: { id: string; archivedAt: string | null }) =>
          v.id === original.id && v.archivedAt != null,
      ),
    ).toBe(true);
  });
});
