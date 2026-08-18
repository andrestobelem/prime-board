import { describe, expect, it } from "bun:test";
import { appendUniqueById } from "../src/pagination.ts";

type Item = { id: string; title: string };

describe("cursor pagination", () => {
  it("appends pages in order without duplicating an overlapping cursor item", () => {
    const first: Item[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const second: Item[] = [
      { id: "b", title: "B (replayed)" },
      { id: "c", title: "C" },
    ];

    expect(appendUniqueById(first, second)).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ]);
  });
});
