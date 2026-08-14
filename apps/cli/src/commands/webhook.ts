// pb webhook list|create|delete
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const USAGE = `Usage:
  pb webhook list [--json]
  pb webhook create --url URL [--events a,b] [--secret TEXT] [--json]
  pb webhook delete <ID>`;

export async function webhookCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(config, "{ webhooks { id url events enabled createdAt } }");
    if (values.json) return printJson(data.webhooks);
    for (const hook of data.webhooks) {
      console.log(`${hook.id}  ${hook.url}  [${hook.events.join(", ")}]${hook.enabled ? "" : "  (disabled)"}`);
    }
    if (data.webhooks.length === 0) console.log("No webhooks registered.");
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        url: { type: "string" }, events: { type: "string" },
        secret: { type: "string" }, json: { type: "boolean" },
      },
    });
    if (!values.url) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { url: values.url };
    if (values.events) input.events = values.events.split(",").map((event) => event.trim());
    if (values.secret) input.secret = values.secret;

    const data = await gqlRequest(config, `mutation($input: WebhookCreateInput!) {
      webhookCreate(input: $input) { webhook { id url events } secret }
    }`, { input });
    if (values.json) return printJson(data.webhookCreate);
    const { webhook, secret } = data.webhookCreate;
    console.log(`Created webhook ${webhook.id} → ${webhook.url} [${webhook.events.join(", ")}]`);
    console.log(`Signing secret (save it now, it will not be shown again): ${secret}`);
    return;
  }

  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    await gqlRequest(config, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, { id });
    console.log(`Deleted webhook ${id}`);
    return;
  }

  throw new UsageError(USAGE);
}
