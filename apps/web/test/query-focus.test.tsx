import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { useState } from "react";
import { useQuery } from "../src/api.ts";

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    value: () => undefined,
  });
  return dom;
}

let updateSearch: ((value: string) => void) | undefined;

function SearchHarness() {
  const [search, setSearch] = useState("");
  updateSearch = setSearch;
  const query = useQuery<{ documents: string[] }>(
    "query($search: String) { documents(search: $search) }",
    { search },
  );
  if (query.loading && !query.data) return <div>Loading…</div>;
  return (
    <input
      aria-label="Search documents"
      value={search}
      onChange={(event) => setSearch(event.target.value)}
    />
  );
}

describe("query input focus", () => {
  test("keeps the input mounted while a changed query is loading", async () => {
    const dom = installDom();
    let requestCount = 0;
    let resolveSecondRequest: (() => void) | undefined;
    const secondRequest = new Promise<void>((resolve) => {
      resolveSecondRequest = resolve;
    });
    const response = () =>
      ({
        ok: true,
        json: async () => ({ data: { documents: [] } }),
      }) as Response;
    globalThis.fetch = (async () => {
      requestCount += 1;
      if (requestCount === 1) return response();
      await secondRequest;
      return response();
    }) as unknown as typeof fetch;

    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("Test root is missing.");
    const root = createRoot(container);
    await act(async () => {
      root.render(<SearchHarness />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(requestCount).toBe(1);
    const input = container.querySelector("input");
    if (!(input instanceof dom.window.HTMLInputElement)) {
      throw new Error("Search input is missing after the initial request.");
    }
    input.focus();
    await act(async () => {
      updateSearch?.("w");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(requestCount).toBe(2);
    expect(container.querySelector("input")).not.toBeNull();
    expect(dom.window.document.activeElement).toBe(container.querySelector("input"));

    resolveSecondRequest?.();
    await act(async () => {
      await secondRequest;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.unmount();
    });
  });
});
