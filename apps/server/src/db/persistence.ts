/** Valores que se pueden enlazar de forma segura como parámetros SQL. */
export type SqlValue = string | bigint | Uint8Array | number | boolean | null;
export type SqlParameters = readonly SqlValue[];

export interface PersistenceResult<Row extends object = Record<string, unknown>> {
  /** Filas producidas por una sentencia, incluidas las de `RETURNING`. */
  readonly rows: readonly Row[];
  /** Cantidad de filas afectadas por la sentencia. */
  readonly rowCount: number;
  /** Identificador generado por la última inserción, si el driver lo ofrece. */
  readonly lastInsertId?: number | bigint;
}

export type PersistenceOperation = "one" | "many" | "execute" | "transaction" | "close";

/** Error estable para que el dominio no dependa del driver subyacente. */
export class PersistenceError extends Error {
  readonly operation: PersistenceOperation;
  override readonly cause: unknown;

  constructor(operation: PersistenceOperation, cause: unknown) {
    super(`Persistence ${operation} failed`, { cause });
    this.name = "PersistenceError";
    this.operation = operation;
    this.cause = cause;
  }
}

/** Operaciones disponibles dentro de una transacción. */
export interface PersistenceTransaction {
  one<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParameters,
  ): Promise<Row | null>;
  many<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParameters,
  ): Promise<readonly Row[]>;
  execute<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParameters,
  ): Promise<PersistenceResult<Row>>;
}

/** Contrato async común para SQLite y futuros drivers PostgreSQL. */
export interface Persistence extends PersistenceTransaction {
  transaction<Result>(callback: (tx: PersistenceTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}
