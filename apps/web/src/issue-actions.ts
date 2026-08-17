import type { IssueActionInput } from "./components/IssueActions.tsx";

export interface IssueMutationResult {
  issueUpdate?: { success: boolean };
  issueArchive?: { success: boolean };
}

export function archiveMutation(): string {
  return `mutation($id: ID!) { issueArchive(id: $id) { success } }`;
}

export function issueUpdateMutation(): string {
  return `mutation($id: ID!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }`;
}

export async function runIssueActions(
  ids: readonly string[],
  action: (id: string) => Promise<{ success: boolean }>,
): Promise<number> {
  let completed = 0;
  for (const id of ids) {
    const result = await action(id);
    if (!result.success) throw new Error(`Could not update issue ${id}.`);
    completed += 1;
  }
  return completed;
}

export function isIssueActionInput(value: unknown): value is IssueActionInput {
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}
