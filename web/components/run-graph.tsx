"use client";

import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo } from "react";
import { formatDuration } from "@/lib/format";
import { NODE_HEIGHT, NODE_WIDTH, type GraphLayout } from "@/lib/layout";
import type { Graph, Step, StepDef } from "@/lib/types";
import { Lamp, statusWord } from "./lamp";

type StepNodeData = { def: StepDef; step: Step | undefined; selected: boolean; now: number; onSelect: (id: string) => void };
type StepFlowNode = Node<StepNodeData, "step">;

const StepNode = memo(function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { def, step, selected, now, onSelect } = data;
  const status = step?.status ?? "pending";
  const elapsed = step?.startedAt ? (step.finishedAt ?? now) - step.startedAt : null;

  return (
    <div
      className="step-node"
      // Focusable with a button's keys, so the graph can be walked without a mouse.
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Step ${def.id}, ${statusWord(status).toLowerCase()}`}
      // The borders live in the stylesheet: the final step's buffer stop is one edge of the
      // same border, which React cannot express next to a width for all four sides.
      data-status={status}
      data-selected={selected ? "" : undefined}
      data-final={def.final ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(def.id);
        }
      }}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} isConnectable={false} />
      <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
        <Lamp state={status} />
        <span className="mono truncate" style={{ fontSize: 13, fontWeight: 600 }} title={def.id}>
          {def.id}
        </span>
      </div>
      <div className="flex items-center gap-3" style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)", paddingLeft: 18 }}>
        <span>{statusWord(status)}</span>
        {elapsed !== null && status !== "pending" && <span>{formatDuration(elapsed)}</span>}
        {(step?.attempt ?? 0) > 1 && <span>attempt {step!.attempt}</span>}
        {step?.cached && <span>cached</span>}
        {def.tools.includes("search") && <span title="Uses web search">search</span>}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { step: StepNode };

export function RunGraph(props: {
  graph: Graph;
  layout: GraphLayout;
  graphVersion: number;
  steps: Record<string, Step>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  const { graph, steps, selectedId, now, onSelect } = props;
  const positions = props.layout.positions;

  const nodes: StepFlowNode[] = graph.steps.map((def) => ({
    id: def.id,
    type: "step",
    position: positions[def.id]!,
    data: { def, step: steps[def.id], selected: def.id === selectedId, now, onSelect },
    draggable: false,
    connectable: false,
  }));

  const edges: Edge[] = graph.steps.flatMap((def) =>
    def.dependsOn.map((dep) => {
      const sourceDone = steps[dep]?.status === "succeeded";
      const targetRunning = steps[def.id]?.status === "running";
      return {
        id: `${dep}->${def.id}`,
        source: dep,
        target: def.id,
        type: "default",
        animated: targetRunning,
        style: { stroke: sourceDone ? "var(--ink-2)" : "var(--rule-strong)", strokeWidth: 2 },
      };
    }),
  );

  return (
    <div style={{ height: "100%" }}>
      <ReactFlow
        key={props.graphVersion}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
        minZoom={0.25}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} size={1.2} color="var(--rule)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
