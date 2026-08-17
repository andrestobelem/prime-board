// Validación compartida de valores DateTime recibidos por la API.
import { apiError } from "../graphql/errors.ts";

export function parseDateTime(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw apiError("VALIDATION_FAILED", `${field} must be a valid ISO-8601 date`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw apiError("VALIDATION_FAILED", `${field} must be a valid ISO-8601 date`);
  }
  return timestamp;
}
