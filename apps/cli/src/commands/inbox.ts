// pb inbox list|read|archive
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const INBOX_FIELDS = `id type payload createdAt isRead isArchived
  actor { id name type } issue { id identifier title }`;
const USAGE = `Usage:
  pb inbox list [--include-archived] [--first N] [--json]
  pb inbox read <ID> [--json]
  pb inbox archive <ID> [--json]`;

export async function inboxCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        "include-archived": { type: "boolean" },
        first: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const first = values.first ? Number(values.first) : 50;
    if (!Number.isInteger(first) || first < 1)
      throw new UsageError(`Invalid first: ${values.first}`);
    const data = await gqlRequest(
      config,
      `query($first: Int, $includeArchived: Boolean) { inbox(first: $first, includeArchived: $includeArchived) { ${INBOX_FIELDS} } }`,
      { first, includeArchived: Boolean(values["include-archived"]) },
    );
    if (values.json) return printJson(data.inbox);
    for (const item of data.inbox)
      console.log(
        `${item.id}  [${item.isRead ? "read" : "unread"}]  ${item.issue.identifier}  ${item.type}`,
      );
    if (data.inbox.length === 0) console.log("Inbox is empty.");
    return;
  }
  if (action === "read" || action === "archive") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const mutation = action === "read" ? "inboxMarkRead" : "inboxArchive";
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { ${mutation}(id: $id) { inboxItem { ${INBOX_FIELDS} } } }`,
      { id },
    );
    if (values.json) return printJson(data[mutation].inboxItem);
    console.log(`${action === "read" ? "Marked read" : "Archived"} inbox item ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
