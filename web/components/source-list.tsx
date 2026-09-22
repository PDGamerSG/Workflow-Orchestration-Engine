import { webUrl } from "@/lib/format";

/** Numbered citations. A source whose URL is not a web link is shown without one. */
export function SourceList({ sources, fontSize = 13 }: { sources: { title: string; url: string; steps?: string[] }[]; fontSize?: number }) {
  return (
    <ol style={{ listStyle: "decimal", paddingLeft: 20, fontSize }}>
      {sources.map((source, index) => {
        const href = webUrl(source.url);
        return (
          // A model can repeat a URL, so the index keeps the keys unique.
          <li key={`${index}-${source.url}`} style={{ marginBottom: 4 }}>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer noopener" style={{ textUnderlineOffset: 2 }}>
                {source.title}
              </a>
            ) : (
              <span title={source.url}>{source.title}</span>
            )}
            {source.steps && source.steps.length > 0 && <span className="hint"> {source.steps.join(", ")}</span>}
          </li>
        );
      })}
    </ol>
  );
}
