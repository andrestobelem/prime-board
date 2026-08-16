import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("team memberships y alcance de iniciativas", () => {
  it("permite administrar miembros y oculta iniciativas de teams ajenos", async () => {
    const setup = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = setup.data!.team.id as string;

    const otherTeam = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other", key: "OT" }) { team { id key } } }`,
    );
    const otherTeamId = otherTeam.data!.teamCreate.team.id as string;

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "team-viewer", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const apiKey = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "team viewer" }) { key } }`,
      { actorId },
    );
    const key = apiKey.data!.apiKeyCreate.key as string;

    const membership = await gql(
      app,
      `mutation($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) { membership { teamId actor { id } role } }
      }`,
      { input: { teamId, actorId, role: "MEMBER" } },
    );
    expect(membership.errors).toBeUndefined();
    expect(membership.data!.teamMembershipCreate.membership.role).toBe("MEMBER");

    const visible = await gql(
      app,
      `mutation($input: InitiativeCreateInput!) {
        initiativeCreate(input: $input) { initiative { id teams { key } } }
      }`,
      { input: { name: "PB initiative", teamIds: [teamId] } },
    );
    const visibleId = visible.data!.initiativeCreate.initiative.id as string;

    const hidden = await gql(
      app,
      `mutation($input: InitiativeCreateInput!) {
        initiativeCreate(input: $input) { initiative { id } }
      }`,
      { input: { name: "OT initiative", teamIds: [otherTeamId] } },
    );
    const hiddenId = hidden.data!.initiativeCreate.initiative.id as string;

    const initiatives = await gql(app, `{ initiatives { id teams { key } } }`, {}, key);
    expect(initiatives.errors).toBeUndefined();
    expect(initiatives.data!.initiatives).toEqual([{ id: visibleId, teams: [{ key: "PB" }] }]);

    const hiddenView = await gql(
      app,
      `query($id: ID!) { initiative(id: $id) { id } }`,
      { id: hiddenId },
      key,
    );
    expect(hiddenView.errors).toBeUndefined();
    expect(hiddenView.data!.initiative).toBeNull();

    const denied = await gql(
      app,
      `mutation($id: ID!) { initiativeUpdate(id: $id, input: { name: "Nope" }) { success } }`,
      { id: hiddenId },
      key,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("preserva memberships y alcance de iniciativas en export e import", async () => {
    const setup = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = setup.data!.team.id as string;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "roundtrip-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const apiKey = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "roundtrip" }) { key } }`,
      { actorId },
    );
    const key = apiKey.data!.apiKeyCreate.key as string;
    await gql(
      app,
      `mutation($input: TeamMembershipCreateInput!) {
        teamMembershipCreate(input: $input) { success }
      }`,
      { input: { teamId, actorId } },
    );
    await gql(
      app,
      `mutation($input: InitiativeCreateInput!) {
        initiativeCreate(input: $input) { success }
      }`,
      { input: { name: "Roundtrip scoped", teamIds: [teamId] } },
    );

    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pb-membership-roundtrip-"));
    try {
      exportBoard(app.db, dir);
      const result = rebuildFromRepo(app.db, dir);
      expect(result.issues).toBeGreaterThanOrEqual(0);
      const initiatives = await gql(app, `{ initiatives { name teams { key } } }`, {}, key);
      expect(initiatives.errors).toBeUndefined();
      expect(initiatives.data!.initiatives).toContainEqual({
        name: "Roundtrip scoped",
        teams: [{ key: "PB" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
