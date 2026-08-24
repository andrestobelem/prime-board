import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { MarkdownContent } from "../src/components/MarkdownContent.tsx";

function readSourceFile(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

function renderMarkdownContent(text: string): string {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });

  try {
    return renderToStaticMarkup(createElement(MarkdownContent, { text }));
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    dom.window.close();
  }
}

describe("Markdown rendering surfaces", () => {
  test("uses the shared renderer for initiative and project descriptions", () => {
    const initiative = readSourceFile("views/InitiativeView.tsx");
    const project = readSourceFile("views/ProjectView.tsx");

    expect(initiative).toContain("MarkdownContent");
    expect(initiative).toContain('className="markdown initiative-description"');
    expect(initiative).not.toContain(">\n          {initiative.description}\n");
    expect(project).toContain("MarkdownContent");
    expect(project).toContain('className="markdown project-description"');
    expect(project).not.toContain(">\n            {project.description}\n");
  });

  test("renders project updates and risks through MarkdownContent", () => {
    const project = readSourceFile("views/ProjectView.tsx");

    expect(project).toContain("text={update.body}");
    expect(project).toContain("text={update.risks}");
    expect(project).toContain('className="project-update-risks"');
  });

  test("renders Markdown syntax through the shared component", () => {
    const html = renderMarkdownContent(
      "# Heading\n\nParagraph with [a link](https://example.com).\n\n- first\n- second\n\n`code`\n\nline one  \nline two<script>alert(1)</script>",
    );

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain('<p>Paragraph with <a href="https://example.com">a link</a>.</p>');
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("line one<br>line two");
    expect(html).not.toContain("<script");
  });
});
