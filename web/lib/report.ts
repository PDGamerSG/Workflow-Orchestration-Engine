import { webUrl } from "./format";

export type ReportSource = { title: string; url: string };

/**
 * A source's title comes from the model, and it lands inside markdown link syntax. Escaping the
 * characters that carry meaning there keeps a title like `](http://elsewhere) [` from rewriting
 * the link when the downloaded file is rendered somewhere else.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>#|]/g, "\\$&").replace(/\r?\n/g, " ").trim();
}

/**
 * The report as a file: the goal as a heading, the answer, then the sources the run used.
 * Only http and https sources become links, the same rule the page applies.
 */
export function reportMarkdown(goal: string | null, output: string, sources: ReportSource[]): string {
  const head = goal ? `# ${escapeMarkdown(goal)}\n\n` : "";
  const linkable = sources.filter((source) => webUrl(source.url));
  const list = linkable.map((source, i) => `${i + 1}. [${escapeMarkdown(source.title) || "Untitled"}](<${source.url}>)`).join("\n");
  const cited = linkable.length > 0 ? `\n\n## Sources this run used\n\n${list}\n` : "";
  return `${head}${output.trim()}${cited}`;
}
