import { describe, expect, test } from "bun:test";
import { ISSUE_QUERY, subscriptionButtonLabel } from "../src/views/IssueView.tsx";

describe("issue subscription UI", () => {
  test("requests subscribers and toggles the button label", () => {
    expect(ISSUE_QUERY).toContain("subscribers { id name type }");
    expect(subscriptionButtonLabel([{ id: "viewer" }], "viewer")).toBe("Unfollow");
    expect(subscriptionButtonLabel([], "viewer")).toBe("Follow");
    expect(subscriptionButtonLabel([{ id: "other" }], "viewer")).toBe("Follow");
  });
});
