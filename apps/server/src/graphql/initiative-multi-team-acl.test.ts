// PRB-651: el alcance multi-Team usa membresía en cualquier Team.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
const keys: Record<string, string> = {};
let oneTeamInitiativeId: string;
let noTeamsInitiativeId: string;
let pbTeamId: string;
let oxTeamId: string;

async function createActorKey(name: string): Promise<string> {
  const actor = await gql(
    app,
    `mutation($name: String!) {
      actorCreate(input: { name: $name, type: AGENT }) { actor { id } }
    }`,
    { name },
  );
  expect(actor.errors).toBeUndefined();
  const actorId = actor.data!.actorCreate.actor.id as string;
  const key = await gql(
    app,
    `mutation($actorId: ID!, $name: String!) {
      apiKeyCreate(input: { actorId: $actorId, name: $name }) { key }
    }`,
    { actorId, name: `${name} key` },
  );
  expect(key.errors).toBeUndefined();
  return key.data!.apiKeyCreate.key as string;
}

async function addMembership(actorKey: string, teamId: string): Promise<void> {
  const actor = await gql(app, `{ viewer { id } }`, {}, actorKey);
  expect(actor.errors).toBeUndefined();
  const result = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) {
      teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success }
    }`,
    { actorId: actor.data!.viewer.id, teamId },
  );
  expect(result.errors).toBeUndefined();
}

describe("Initiative multi-Team ACL", () => {
  beforeAll(async () => {
    const pb = await gql(app, `{ team(key: "PB") { id } }`);
    expect(pb.errors).toBeUndefined();
    pbTeamId = pb.data!.team.id as string;

    const ox = await gql(
      app,
      `mutation {
        teamCreate(input: {
          name: "PRB-651 other Team", key: "OX", visibility: PRIVATE, accessPolicy: TEAM_MEMBERS
        }) { team { id } }
      }`,
    );
    expect(ox.errors).toBeUndefined();
    oxTeamId = ox.data!.teamCreate.team.id as string;

    keys.one = await createActorKey("PRB-651 member of one Team");
    keys.all = await createActorKey("PRB-651 member of all Teams");
    keys.outsider = await createActorKey("PRB-651 outsider");
    await addMembership(keys.one, pbTeamId);
    await addMembership(keys.all, pbTeamId);
    await addMembership(keys.all, oxTeamId);

    const scoped = await gql(
      app,
      `mutation($teamIds: [ID!]!) {
        initiativeCreate(input: { name: "PRB-651 multi-Team", teamIds: $teamIds }) {
          initiative { id }
        }
      }`,
      { teamIds: [pbTeamId, oxTeamId] },
    );
    expect(scoped.errors).toBeUndefined();
    oneTeamInitiativeId = scoped.data!.initiativeCreate.initiative.id as string;
    // El owner no es parte de esta regresión. Así se verifica la ACL de lectura y edición.
    app.db.query("UPDATE initiatives SET owner_id = NULL WHERE id = ?1").run(oneTeamInitiativeId);

    const empty = await gql(
      app,
      `mutation {
        initiativeCreate(input: { name: "PRB-651 no Teams", teamIds: [] }) {
          initiative { id }
        }
      }`,
    );
    expect(empty.errors).toBeUndefined();
    noTeamsInitiativeId = empty.data!.initiativeCreate.initiative.id as string;
    app.db.query("UPDATE initiatives SET owner_id = NULL WHERE id = ?1").run(noTeamsInitiativeId);
  });

  afterAll(() => app.stop());

  it("permite ver y editar con membresía en un Team, y filtra nested teams", async () => {
    const result = await gql(app, `{ initiatives { id name teams { key } } }`, {}, keys.one);
    expect(result.errors).toBeUndefined();
    expect(result.data!.initiatives).toContainEqual({
      id: oneTeamInitiativeId,
      name: "PRB-651 multi-Team",
      teams: [{ key: "PB" }],
    });

    const update = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { name: "PRB-651 updated by one Team" }) { success }
      }`,
      { id: oneTeamInitiativeId },
      keys.one,
    );
    expect(update.errors).toBeUndefined();
    expect(update.data!.initiativeUpdate.success).toBe(true);
  });

  it("permite ver y editar con membresía en todos los Teams", async () => {
    const result = await gql(
      app,
      `query($id: ID!) { initiative(id: $id) { id teams { key } } }`,
      { id: oneTeamInitiativeId },
      keys.all,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.initiative).toEqual({
      id: oneTeamInitiativeId,
      teams: [{ key: "PB" }, { key: "OX" }],
    });

    const update = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { name: "PRB-651 updated by all Teams" }) { success }
      }`,
      { id: oneTeamInitiativeId },
      keys.all,
    );
    expect(update.errors).toBeUndefined();
    expect(update.data!.initiativeUpdate.success).toBe(true);
  });

  it("oculta una Initiative multi-Team al outsider, pero mantiene las sin Teams", async () => {
    const result = await gql(app, `{ initiatives { id name teams { key } } }`, {}, keys.outsider);
    expect(result.errors).toBeUndefined();
    expect(result.data!.initiatives).toEqual([
      { id: noTeamsInitiativeId, name: "PRB-651 no Teams", teams: [] },
    ]);

    const update = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { name: "PRB-651 outsider update" }) { success }
      }`,
      { id: oneTeamInitiativeId },
      keys.outsider,
    );
    expect(update.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
