// Test del despacho único de sync (AT-191): el mecanismo en sí, sin
// necesidad de un server completo — un RepoSync de mentira alcanza.
import { describe, expect, it, mock } from "bun:test";
import {
  SYNC_EXCLUDED_MUTATIONS,
  trackedRepoSync,
  withRepoSyncDispatch,
} from "./repo-sync-dispatch.ts";
import type { RepoSync } from "../export/repo-sync.ts";

function fakeRepo(): RepoSync & { syncCalls: number; syncIssueCalls: string[] } {
  const state = { syncCalls: 0, syncIssueCalls: [] as string[] };
  return {
    root: "/tmp/fake-repo",
    sync: () => {
      state.syncCalls += 1;
    },
    syncIssue: (issueId: string) => {
      state.syncIssueCalls.push(issueId);
    },
    get syncCalls() {
      return state.syncCalls;
    },
    get syncIssueCalls() {
      return state.syncIssueCalls;
    },
  };
}

describe("trackedRepoSync", () => {
  it("delega en el repo real y rastrea si se lo llamó", () => {
    const repo = fakeRepo();
    const tracker = trackedRepoSync(repo);
    expect(tracker.wasCalled()).toBe(false);
    tracker.syncIssue("issue-1");
    expect(tracker.wasCalled()).toBe(true);
    expect(repo.syncIssueCalls).toEqual(["issue-1"]);
  });

  it("reset() vuelve a false para la siguiente mutation del mismo request", () => {
    const tracker = trackedRepoSync(fakeRepo());
    tracker.sync();
    tracker.reset();
    expect(tracker.wasCalled()).toBe(false);
  });
});

describe("withRepoSyncDispatch", () => {
  it("dispara un sync() de respaldo si el resolver no sincronizó nada por su cuenta", () => {
    const repo = fakeRepo();
    const tracker = trackedRepoSync(repo);
    const olvidadizo = mock((_p: unknown, _a: unknown, _c: unknown) => ({ success: true }));
    const wrapped = withRepoSyncDispatch({ someMutation: olvidadizo });

    wrapped.someMutation(null, {}, { repo: tracker });

    expect(olvidadizo).toHaveBeenCalledTimes(1);
    expect(repo.syncCalls).toBe(1);
  });

  it("no duplica el sync si el resolver ya sincronizó a mano (completo o dirigido)", () => {
    const repo = fakeRepo();
    const tracker = trackedRepoSync(repo);
    const prolijo = mock((_p: unknown, _a: unknown, context: { repo: typeof tracker }) => {
      context.repo.syncIssue("issue-42");
      return { success: true };
    });
    const wrapped = withRepoSyncDispatch({ issueUpdate: prolijo });

    wrapped.issueUpdate(null, {}, { repo: tracker });

    expect(repo.syncIssueCalls).toEqual(["issue-42"]);
    expect(repo.syncCalls).toBe(0); // sin sync de respaldo — ya se sincronizó
  });

  it("las mutations excluidas (secretos) nunca disparan sync, aunque el resolver no sincronice", () => {
    const repo = fakeRepo();
    const tracker = trackedRepoSync(repo);
    const wrapped = withRepoSyncDispatch({
      apiKeyCreate: (..._args: unknown[]) => ({ success: true }),
      webhookDelete: (..._args: unknown[]) => ({ success: true }),
    });

    wrapped.apiKeyCreate(null, {}, { repo: tracker });
    wrapped.webhookDelete(null, {}, { repo: tracker });

    expect(repo.syncCalls).toBe(0);
    expect(repo.syncIssueCalls).toEqual([]);
  });

  it("SYNC_EXCLUDED_MUTATIONS son exactamente las 4 de secretos, declaradas por nombre", () => {
    expect([...SYNC_EXCLUDED_MUTATIONS].sort()).toEqual(
      ["apiKeyCreate", "apiKeyDelete", "webhookCreate", "webhookDelete"].sort(),
    );
  });

  it("funciona con resolvers async: espera la promesa antes de decidir si hace falta el respaldo", async () => {
    const repo = fakeRepo();
    const tracker = trackedRepoSync(repo);
    const asincronico = async (_p: unknown, _a: unknown, _c: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { success: true };
    };
    const wrapped = withRepoSyncDispatch({ algoAsync: asincronico });

    const result = await wrapped.algoAsync(null, {}, { repo: tracker });

    expect(result).toEqual({ success: true });
    expect(repo.syncCalls).toBe(1);
  });

  it("sin context.repo (PRIME_BOARD_REPO no configurado) no rompe, solo pasa de largo", () => {
    const resolver = mock((..._args: unknown[]) => ({ success: true }));
    const wrapped = withRepoSyncDispatch({ teamCreate: resolver });
    expect(() => wrapped.teamCreate(null, {}, { repo: null })).not.toThrow();
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
