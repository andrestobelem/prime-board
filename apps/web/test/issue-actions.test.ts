import { describe, expect, test } from "bun:test";
import { runIssueActions } from "../src/issue-actions.ts";

describe("issue action runner", () => {
  test("runs sequentially and reports completed order", async () => {
    const order: string[] = [];
    const count = await runIssueActions(["a", "b"], async (id) => {
      order.push(id);
      return { success: true };
    });
    expect(count).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });

  test("stops at the first failed mutation", async () => {
    const order: string[] = [];
    await expect(
      runIssueActions(["a", "b"], async (id) => {
        order.push(id);
        return { success: id === "a" };
      }),
    ).rejects.toThrow("Could not update issue b");
    expect(order).toEqual(["a", "b"]);
  });
});
