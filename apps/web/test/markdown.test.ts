// Tests de AT-154: el markdown renderizado no puede ejecutar JS.
// Nota: usamos jsdom, no happy-dom — con happy-dom DOMPurify degrada y deja
// pasar los `on*` (el test verde sería un falso positivo peligroso).
import { describe, expect, it } from "bun:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { createMarkdownRenderer, type Purifier } from "../src/markdown.ts";

const { window } = new JSDOM("");
const render = createMarkdownRenderer(
  createDOMPurify(window as unknown as Window & typeof globalThis) as unknown as Purifier,
);

describe("renderMarkdown", () => {
  it("elimina handlers on* (el vector reportado en AT-154)", () => {
    const html = render(`Hola <img src=x onerror="document.title='PWNED'"> **negrita**`);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("PWNED");
    expect(html).toContain("<strong>negrita</strong>");
  });

  it("descarta <script> y protocolos javascript:", () => {
    const html = render(`<script>window.__xss=1</script><a href="javascript:alert(1)">link</a>`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("link");
  });

  it("bloquea iframes y estilos inline", () => {
    const html = render(`<iframe src="https://evil.test"></iframe><p style="position:fixed">x</p>`);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("style=");
  });

  it("conserva el markdown legítimo", () => {
    const html = render("# Título\n\n- item\n\n`code` y [link](https://example.com)");
    expect(html).toContain("<h1>");
    expect(html).toContain("<li>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });
});
