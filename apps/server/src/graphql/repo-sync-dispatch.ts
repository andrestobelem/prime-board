// Punto único de despacho de sync para las mutations (AT-191, candidato B del
// architecture review de AT-181/AT-182..190).
//
// El despacho reserva el lock del Repository Source antes del resolver. La
// reserva vive hasta que terminan resolver, append, commit y export; solo
// entonces retira una captura histórica de Documents. Si el resolver falla,
// aborta la reserva y conserva la captura.
import type { RepoSync, RepoSyncLease } from "../export/repo-sync.ts";

/**
 * Mutations que a propósito nunca tocan el repo: secretos o estado personal
 * excluido de la réplica (ADR-0004).
 */
export const SYNC_EXCLUDED_MUTATIONS: ReadonlySet<string> = new Set([
  "apiKeyCreate",
  "apiKeyDelete",
  "webhookCreate",
  "webhookDelete",
  "inboxMarkRead",
  "inboxArchive",
]);

export interface TrackedRepoSync extends RepoSync {
  /** Verifica y reserva fuentes retiradas antes del resolver. */
  preflight(): void;
  /** Variante no bloqueante para el dispatcher HTTP. */
  preflightAsync(): void | Promise<void>;
  /** ¿Se llamó a sync()/syncIssue() desde que se reseteó el rastreo? */
  wasCalled(): boolean;
  /** Completa la reserva después de que resolver y sync terminaron bien. */
  complete(): void;
  /** Libera la reserva sin retirar una captura. */
  abort(): void;
  /** Reinicia el rastreo — se llama antes de cada mutation top-level. */
  reset(): void;
}

function isRepoSyncLease(value: unknown): value is RepoSyncLease {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof Reflect.get(value, "complete") === "function" &&
    typeof Reflect.get(value, "abort") === "function",
  );
}

/**
 * Envuelve un RepoSync para rastrear si se lo usó y conservar su reserva por
 * request. Las implementaciones antiguas que devuelven `void` desde preflight
 * siguen funcionando; el RepoSync real devuelve un lease.
 */
export function trackedRepoSync(repo: RepoSync): TrackedRepoSync {
  let called = false;
  let lease: RepoSyncLease | undefined;
  const abortLease = () => {
    const current = lease;
    lease = undefined;
    current?.abort();
  };
  const storeLease = (candidate: unknown): void => {
    lease = isRepoSyncLease(candidate) ? candidate : undefined;
  };
  const preflightAsync = (): void | Promise<void> => {
    abortLease();
    const candidate =
      typeof repo.preflightAsync === "function" ? repo.preflightAsync() : repo.preflight();
    return settleMaybe(
      candidate,
      (resolved) => {
        storeLease(resolved);
        return undefined;
      },
      (error) => {
        lease = undefined;
        throw error;
      },
    ) as void | Promise<void>;
  };
  return {
    root: repo.root,
    preflight() {
      abortLease();
      storeLease(repo.preflight());
    },
    preflightAsync,
    sync() {
      called = true;
      return repo.sync(lease);
    },
    syncIssue(issueId: string) {
      called = true;
      return repo.syncIssue(issueId, lease);
    },
    complete() {
      const current = lease;
      if (!current) return;
      try {
        current.complete();
        lease = undefined;
      } catch (error) {
        lease = undefined;
        current.abort();
        throw error;
      }
    },
    abort: abortLease,
    wasCalled: () => called,
    reset: () => {
      called = false;
      abortLease();
    },
  };
}

// Firma laxa a propósito: cada resolver de Mutation tiene su propio tipo de
// `args` (issueCreate, teamUpdate, etc no comparten forma) — el wrapper no
// necesita conocerla, solo reenviar los argumentos tal cual llegaron.
type AnyResolver = (...args: any[]) => unknown;

type ThenHandler = (value: unknown) => void;
type ThenInvoker = (onFulfilled: ThenHandler, onRejected: ThenHandler) => void;

/** Lee `.then` una sola vez y lo invoca con el receptor correcto. */
function getThenInvoker(value: unknown): ThenInvoker | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const then = Reflect.get(value, "then");
  if (typeof then !== "function") return undefined;
  return (onFulfilled, onRejected) => {
    Reflect.apply(then, value, [onFulfilled, onRejected]);
  };
}

/**
 * Asimila Promises y thenables sin leer `.then` dos veces. También conserva el
 * comportamiento síncrono para los resolvers síncronos, pero convierte toda
 * contención o promesa real en una cadena que GraphQL puede await.
 */
function settleMaybe(
  value: unknown,
  onFulfilled: (value: unknown) => unknown,
  onRejected: (error: unknown) => unknown,
): unknown {
  let then: ThenInvoker | undefined;
  try {
    then = getThenInvoker(value);
  } catch (error) {
    return onRejected(error);
  }
  if (!then) return onFulfilled(value);

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const fulfilled: ThenHandler = (resolved) => {
      if (settled) return;
      settled = true;
      try {
        resolve(onFulfilled(resolved));
      } catch (error) {
        reject(error);
      }
    };
    const rejected: ThenHandler = (error) => {
      if (settled) return;
      settled = true;
      try {
        resolve(onRejected(error));
      } catch (failure) {
        reject(failure);
      }
    };
    try {
      then(fulfilled, rejected);
    } catch (error) {
      rejected(error);
    }
  });
}

interface DispatchContext {
  readonly repo?: TrackedRepoSync | null;
  readonly auth?: {
    readonly recordUsage?: () => unknown;
  } | null;
}

function recordUsage(context: DispatchContext | undefined): unknown {
  const callback = context?.auth?.recordUsage;
  return typeof callback === "function" ? callback() : undefined;
}

/**
 * Envuelve cada resolver del Mutation map. El resolver corre dentro de la
 * reserva del Repository Source. Al terminar, dispara un sync() de respaldo
 * si el resolver no sincronizó nada y completa la reserva. Un rechazo siempre
 * aborta antes de devolver el error a GraphQL.
 */
/**
 * Marca no enumerable en el objeto que devuelve withRepoSyncDispatch — así un
 * test puede verificar que el Mutation map que de verdad usa el server pasó
 * por acá, sin depender de leer el código fuente (AT-195).
 */
export const DISPATCHED = Symbol("repoSyncDispatched");

export function withRepoSyncDispatch<T extends Record<string, AnyResolver>>(mutations: T): T {
  const wrapped: Record<string, AnyResolver> = {};
  for (const [name, resolver] of Object.entries(mutations)) {
    wrapped[name] = (...callArgs: unknown[]) => {
      const context = callArgs[2] as DispatchContext | undefined;
      const tracker = context?.repo;
      const fail = (error: unknown): never => {
        if (tracker) {
          try {
            tracker.abort();
          } catch {
            // Conservamos el fallo de la mutación, no un error secundario de cleanup.
          }
        }
        throw error;
      };
      const runResolverAndRecord = (): unknown => {
        let result: unknown;
        try {
          result = resolver(...callArgs);
        } catch (error) {
          throw error;
        }
        return settleMaybe(
          result,
          (value) => {
            let usage: unknown;
            try {
              usage = recordUsage(context);
            } catch (error) {
              throw error;
            }
            return settleMaybe(
              usage,
              () => value,
              (error) => {
                throw error;
              },
            );
          },
          (error) => {
            throw error;
          },
        );
      };
      if (!tracker || SYNC_EXCLUDED_MUTATIONS.has(name)) return runResolverAndRecord();

      tracker.reset();
      let preflight: unknown;
      try {
        // La reserva se toma antes de que el resolver pueda escribir SQLite o
        // emitir Activity/eventos canónicos. La variante async nunca espera con
        // Atomics.wait en el event loop HTTP.
        preflight = tracker.preflightAsync();
      } catch (error) {
        return fail(error);
      }
      const finish = (): unknown => {
        let synced: unknown;
        try {
          if (!tracker.wasCalled()) synced = tracker.sync();
        } catch (error) {
          return fail(error);
        }
        return settleMaybe(
          synced,
          () => {
            try {
              tracker.complete();
            } catch (error) {
              return fail(error);
            }
            return undefined;
          },
          fail,
        );
      };
      const execute = (): unknown => {
        let result: unknown;
        try {
          result = resolver(...callArgs);
        } catch (error) {
          return fail(error);
        }
        return settleMaybe(
          result,
          (value) => {
            let finished: unknown;
            try {
              finished = finish();
            } catch (error) {
              return fail(error);
            }
            return settleMaybe(
              finished,
              () => {
                let usage: unknown;
                try {
                  usage = recordUsage(context);
                } catch (error) {
                  return fail(error);
                }
                return settleMaybe(usage, () => value, fail);
              },
              fail,
            );
          },
          fail,
        );
      };
      return settleMaybe(preflight, execute, fail);
    };
  }
  Object.defineProperty(wrapped, DISPATCHED, { value: true, enumerable: false });
  return wrapped as T;
}
