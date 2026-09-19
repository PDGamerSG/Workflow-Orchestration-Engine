import { graphlib, layout } from "@dagrejs/dagre";
import type { Graph } from "./types";

export const NODE_WIDTH = 236;
export const NODE_HEIGHT = 68;

export type GraphLayout = { positions: Record<string, { x: number; y: number }>; width: number; height: number };

/** Left-to-right positions for every step, dependencies before dependents. */
export function layoutGraph(graph: Graph): GraphLayout {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 84, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const step of graph.steps) g.setNode(step.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const step of graph.steps) for (const dep of step.dependsOn) g.setEdge(dep, step.id);

  layout(g);

  const positions = Object.fromEntries(
    graph.steps.map((step) => {
      const node = g.node(step.id);
      return [step.id, { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 }];
    }),
  );
  const size = g.graph();
  return { positions, width: size.width ?? 0, height: size.height ?? 0 };
}
