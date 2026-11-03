import Link from "next/link";
import { TEMPLATES } from "@/lib/templates";

export function TemplateGallery() {
  return (
    <div className="template-grid">
      {TEMPLATES.map((template) => (
        <Link
          className="template-card"
          key={template.id}
          href={`/playground?template=${template.id}`}
        >
          <div className="template-meta">
            <span>{template.category}</span>
            <span>{template.graph.steps.length} steps</span>
          </div>
          <h3>{template.title}</h3>
          <p>{template.description}</p>
          <div className="mini-dag" aria-hidden="true">
            <span />
            <i />
            <span />
            <i />
            <span className="mini-final" />
          </div>
          <span className="template-takeaway">{template.takeaway}</span>
          <span className="template-action">
            Use template <span aria-hidden="true">↗</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
