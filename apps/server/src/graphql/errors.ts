// Errores de API con extensions.code (spec §4, Convenciones).
import { GraphQLError } from "graphql";
import type { Context } from "./context.ts";
import type { ActorRow } from "../auth/viewer.ts";

export type ErrorCode = "NOT_FOUND" | "UNAUTHORIZED" | "VALIDATION_FAILED";

export function apiError(code: ErrorCode, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** Toda operación de la API exige una key válida (spec §5). */
export function requireViewer(context: Context): ActorRow {
  if (!context.viewer) {
    throw apiError("UNAUTHORIZED", "A valid API key is required");
  }
  return context.viewer;
}
