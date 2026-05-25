import { useMemo } from "react";
import ReactFlow, { Background, Controls, Position, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import type { ConcernGraph as Graph, Slice } from "../api/client.js";

interface Props {
  graph: Graph;
  slices: Slice[];
}

const KIND_COLORS: Record<string, string> = {
  feature:  "#3b82f6",
  refactor: "#8b5cf6",
  fix:      "#ef4444",
  test:     "#10b981",
  docs:     "#94a3b8",
  config:   "#f59e0b",
  deps:     "#ec4899",
  style:    "#6366f1",
  chore:    "#64748b",
};

function layoutNodes(graph: Graph, slices: Slice[]): { nodes: Node[]; edges: Edge[] } {
  const concernToSlice = new Map<string, number>();
  slices.forEach((s, i) => s.concernIds.forEach((cid) => concernToSlice.set(cid, i)));

  const cols = slices.length > 0 ? slices.length : 1;
  const rowCount = new Map<number, number>();
  const nodes: Node[] = graph.concerns.map((c) => {
    const col = concernToSlice.get(c.id) ?? cols - 1;
    const row = rowCount.get(col) ?? 0;
    rowCount.set(col, row + 1);
    const color = KIND_COLORS[c.kind] ?? "#64748b";
    return {
      id: c.id,
      data: { label: (
        <div style={{ minWidth: 140 }}>
          <div style={{ fontSize: 10, color, fontWeight: 600, textTransform: "uppercase" }}>{c.kind}</div>
          <div style={{ fontSize: 12 }}>{c.summary.slice(0, 60)}</div>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>{c.hunks.length} hunk(s) · conf {(c.confidence * 100).toFixed(0)}%</div>
        </div>
      ) },
      position: { x: 40 + col * 220, y: 30 + row * 110 },
      style: { borderLeft: `4px solid ${color}`, borderRadius: 6, padding: 8, fontSize: 12 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  const edges: Edge[] = graph.dag.map(([from, to]) => ({
    id: `${from}->${to}`,
    source: from,
    target: to,
    animated: false,
    style: { stroke: "var(--edge)" },
  }));

  return { nodes, edges };
}

export function ConcernGraph({ graph, slices }: Props) {
  const { nodes, edges } = useMemo(() => layoutNodes(graph, slices), [graph, slices]);

  return (
    <div className="rf-wrap">
      <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2 }}>
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
