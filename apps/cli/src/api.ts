// Cliente GraphQL mínimo sobre fetch. El CLI no toca la DB: solo habla con la API.
import type { CliConfig } from "./config.ts";
import { ApiError } from "./errors.ts";

export async function gqlRequest(
  config: CliConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(`${config.url.replace(/\/$/, "")}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new ApiError(`Cannot reach prime-board at ${config.url}: ${error}`);
  }
  const payload = (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new ApiError(first.message, first.extensions?.code);
  }
  return payload.data ?? {};
}
