// Errores del CLI: exit code 1 para errores de API, 2 para errores de uso (spec §7).
export class UsageError extends Error {}

export class ApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}
