// Renderizado seguro de markdown (AT-154).
// `marked` deja pasar HTML crudo por diseño, y la UI lo inyecta con
// dangerouslySetInnerHTML: sin sanitizar, un `onerror` en la descripción de un
// issue ejecuta JS y puede robar la API key del localStorage. Como el contenido
// lo escriben agentes que procesan input externo, esto es una vía directa de
// prompt-injection a XSS. Sanitizamos SIEMPRE antes de inyectar.
import createDOMPurify from "dompurify";
import { marked } from "marked";

export interface Purifier {
  sanitize(html: string, config?: Record<string, unknown>): string;
}

// Perfil HTML estándar: descarta <script>, atributos on* y protocolos peligrosos
// (javascript:, data: en href), conservando el markdown útil.
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
  FORBID_ATTR: ["style"],
};

/** Renderer inyectable: permite testear la configuración sin un browser real. */
export function createMarkdownRenderer(purifier: Purifier) {
  return (text: string): string =>
    purifier.sanitize(marked.parse(text, { async: false }) as string, SANITIZE_CONFIG);
}

let renderer: ((text: string) => string) | null = null;

export function renderMarkdown(text: string): string {
  renderer ??= createMarkdownRenderer(createDOMPurify(window) as unknown as Purifier);
  return renderer(text);
}
