// Cliente GraphQL del MCP server: habla con prime-board vía HTTP (spec §8).
export interface McpConfig {
  url: string;
  apiKey: string;
}

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const url = env.PRIME_BOARD_URL ?? "http://localhost:3333";
  const apiKey = env.PRIME_BOARD_API_KEY;
  if (!apiKey) {
    throw new Error("PRIME_BOARD_API_KEY is required to run the prime-board MCP server");
  }
  return { url, apiKey };
}

export async function gqlRequest(
  config: McpConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = await fetch(`${config.url.replace(/\/$/, "")}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new Error(`${first.extensions?.code ?? "ERROR"}: ${first.message}`);
  }
  return payload.data ?? {};
}
