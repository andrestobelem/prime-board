import {
  PersistenceError,
  type Persistence,
  type PersistenceOperation,
  type PersistenceResult,
  type PersistenceTransaction,
  type SqlParameters,
} from "../persistence.ts";

interface BunQueryResult<Row extends object> extends ReadonlyArray<Row> {
  readonly count?: number;
}

type PostgresClient = Bun.SQL | Bun.ReservedSQL | Bun.TransactionSQL;

function withPersistenceError<T>(
  operation: PersistenceOperation,
  action: () => Promise<T>,
): Promise<T> {
  return action().catch((cause) => {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError(operation, cause);
  });
}

function affectedRows<Row extends object>(result: BunQueryResult<Row>): number {
  return typeof result.count === "number" ? result.count : result.length;
}

function query<Row extends object>(
  client: PostgresClient,
  statement: string,
  params?: SqlParameters,
): Promise<BunQueryResult<Row>> {
  // SQL is supplied by the domain; values remain bound through $1, $2, ...
  return client.unsafe<Row[]>(statement, params ? [...params] : []) as Promise<BunQueryResult<Row>>;
}

function transactionOperations(client: PostgresClient): PersistenceTransaction {
  return {
    one: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) =>
      withPersistenceError("one", async () => {
        const rows = await query<Row>(client, statement, params);
        return rows[0] ?? null;
      }),
    many: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) => withPersistenceError("many", () => query<Row>(client, statement, params)),
    execute: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) =>
      withPersistenceError("execute", async () => {
        const rows = await query<Row>(client, statement, params);
        return { rows, rowCount: affectedRows(rows) } satisfies PersistenceResult<Row>;
      }),
  };
}

/** Adaptador async de Bun.SQL al contrato neutral de Persistence. */
export function createPostgresPersistence(
  sql: Bun.SQL,
  options: { close?: boolean } = {},
): Persistence {
  const operations = transactionOperations(sql);
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Persistence is closed");
  };
  const guard = <T>(action: () => Promise<T>): Promise<T> => {
    assertOpen();
    return action();
  };

  return {
    ...operations,
    one: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) => guard(() => operations.one<Row>(statement, params)),
    many: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) => guard(() => operations.many<Row>(statement, params)),
    execute: <Row extends object = Record<string, unknown>>(
      statement: string,
      params?: SqlParameters,
    ) => guard(() => operations.execute<Row>(statement, params)),
    transaction: <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) =>
      guard(() =>
        withPersistenceError("transaction", () =>
          sql.begin(async (transaction) => callback(transactionOperations(transaction))),
        ),
      ),
    close: async () => {
      if (closed) return;
      try {
        if (options.close !== false) await sql.close({ timeout: 5 });
      } catch (cause) {
        throw new PersistenceError("close", cause);
      } finally {
        closed = true;
      }
    },
  };
}
