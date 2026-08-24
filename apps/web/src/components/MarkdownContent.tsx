import { renderMarkdown } from "../markdown.ts";

export function MarkdownContent({
  text,
  className = "markdown",
}: {
  text: string;
  className?: string;
}) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
