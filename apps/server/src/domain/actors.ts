// Mapeo de filas snake_case a la forma camelCase que expone la API.
import type { ActorRow } from "../auth/viewer.ts";

export function mapActor(row: ActorRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    type: row.type,
    createdAt: row.created_at,
  };
}
