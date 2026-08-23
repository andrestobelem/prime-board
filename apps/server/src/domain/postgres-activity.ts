import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import type { ActivityRow } from "./activity.ts";

export async function listPostgresActivity(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
): Promise<readonly ActivityRow[]> {
  return persistence.many<ActivityRow>(
    "SELECT * FROM activity WHERE issue_id = $1 ORDER BY created_at, id",
    [issueId],
  );
}
