import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
  PersistenceError,
  type Persistence,
  type PersistenceOperation,
  type PersistenceResult,
  type PersistenceTransaction,
  type SqlParameters,
  type SqlValue,
} from "./persistence.ts";

function isReturningStatement(sql: string): boolean {
  return /\bRETURNING\b/i.test(sql);
}

function sqliteParameters(params: SqlParameters): SQLQueryBindings[] {
  return params as unknown as SQLQueryBindings[];
}

function withPersistenceError<T>(operation: PersistenceOperation, action: () => T): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError(operation, cause);
  }
}

/**
 * Adaptador async para la conexión SQLite existente.
 *
 * Las operaciones de Bun SQLite son síncronas; el adaptador las encapsula en
 * Promises para que el dominio no conozca el driver. La transacción usa BEGIN /
 * COMMIT / ROLLBACK explícitos porque el callback del contrato puede ser async.
 * Un consumidor debe esperar cada transacción antes de iniciar otra sobre esta
 * conexión; el driver PostgreSQL proveerá conexiones dedicadas en su adaptador.
 */
export function createSqlitePersistence(db: Database): Persistence {
  let transactionActive = false;
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Persistence is closed");
  };

  const all = <Row extends object>(sql: string, params?: SqlParameters): Row[] => {
    if (params === undefined) return db.query<Row, SQLQueryBindings[]>(sql).all();
    return db.query<Row, SQLQueryBindings[]>(sql).all(...sqliteParameters(params));
  };

  const get = <Row extends object>(sql: string, params?: SqlParameters): Row | null => {
    if (params === undefined) return db.query<Row, SQLQueryBindings[]>(sql).get();
    return db.query<Row, SQLQueryBindings[]>(sql).get(...sqliteParameters(params));
  };

  const execute = <Row extends object>(
    sql: string,
    params?: SqlParameters,
  ): PersistenceResult<Row> =>
    withPersistenceError("execute", () => {
      assertOpen();
      if (isReturningStatement(sql)) {
        const rows = all<Row>(sql, params);
        const changes =
          get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? rows.length;
        return { rows, rowCount: changes };
      }
      const result =
        params === undefined
          ? db.query<Row, SQLQueryBindings[]>(sql).run()
          : db.query<Row, SQLQueryBindings[]>(sql).run(...sqliteParameters(params));
      return { rows: [], rowCount: result.changes, lastInsertId: result.lastInsertRowid };
    });

  const tx: PersistenceTransaction = {
    one: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: SqlParameters,
    ) => {
      return withPersistenceError("one", () => {
        assertOpen();
        return get<Row>(sql, params);
      });
    },
    many: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: SqlParameters,
    ) => {
      return withPersistenceError("many", () => {
        assertOpen();
        return all<Row>(sql, params);
      });
    },
    execute: async <Row extends object = Record<string, unknown>>(
      sql: string,
      params?: SqlParameters,
    ) => execute<Row>(sql, params),
  };

  return {
    ...tx,
    transaction: async <Result>(
      callback: (transaction: PersistenceTransaction) => Promise<Result>,
    ) => {
      if (transactionActive) {
        throw new PersistenceError(
          "transaction",
          new Error("Nested transactions are not supported"),
        );
      }
      assertOpen();
      transactionActive = true;
      try {
        try {
          db.exec("BEGIN");
        } catch (cause) {
          throw new PersistenceError("transaction", cause);
        }
        let result: Result;
        try {
          result = await callback(tx);
        } catch (cause) {
          try {
            db.exec("ROLLBACK");
          } catch (rollbackCause) {
            throw new PersistenceError("transaction", rollbackCause);
          }
          throw cause;
        }
        try {
          db.exec("COMMIT");
        } catch (cause) {
          throw new PersistenceError("transaction", cause);
        }
        return result;
      } finally {
        transactionActive = false;
      }
    },
    close: async () => {
      withPersistenceError("close", () => {
        if (closed) return;
        db.close();
        closed = true;
      });
    },
  };
}
