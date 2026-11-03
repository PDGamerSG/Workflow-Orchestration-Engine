# Interface design

Relay uses a graph/control-room visual language: blue-green accents, status lamps, numbered steps, monospace identifiers and readable output panels. Light and dark themes share semantic CSS tokens. The interface separates provider selection, graph definition and run inspection so the current execution identity stays visible.

The homepage combines a runnable tour with an interactive explanation. The playground exposes six templates and editable goal/graph inputs. Connections explains validation, encryption and browser ownership before a key is submitted. The run inspector preserves the existing graph, step details, report and timeline views.

Responsive navigation and stacked layouts support a 390-pixel viewport. Labels, keyboard-focus styles, a skip link, status text and reduced-motion styles accompany color. The browser suite checks overflow and labelled key controls; this is not a claim of a complete accessibility certification.

Sources: [`globals.css`](../web/app/globals.css), [`layout.tsx`](../web/app/layout.tsx), [`TopBar`](../web/components/top-bar.tsx), [`EngineDiagram`](../web/components/engine-diagram.tsx), [`RunView`](../web/components/run-view.tsx).
