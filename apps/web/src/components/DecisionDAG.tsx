import { useMemo } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentEvent, DecisionRequestEvent } from "@deeppairing/shared";
import { useSessionStore } from "../stores/session";

interface DecisionNode {
  event: DecisionRequestEvent;
  resolved: boolean;
  selectedOptionTitle?: string;
}

function extractDecisionNodes(events: AgentEvent[]): DecisionNode[] {
  const nodes: DecisionNode[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "decision_request") continue;

    const isResolved = events.slice(i + 1).some(
      (e) => e.type === "status" && e.phase === "executing",
    );

    let selectedOptionTitle: string | undefined;
    if (isResolved) {
      const reasoning = events.slice(i + 1).find((e) => e.type === "reasoning");
      if (reasoning?.type === "reasoning") {
        selectedOptionTitle = reasoning.action;
      }
    }

    nodes.push({ event, resolved: isResolved, selectedOptionTitle });
  }

  return nodes;
}

export function DecisionDAG() {
  const events = useSessionStore((s) => s.events);
  const decisionNodes = useMemo(() => extractDecisionNodes(events), [events]);

  const { nodes, edges } = useMemo(() => {
    const flowNodes: Node[] = [
      {
        id: "start",
        type: "default",
        position: { x: 250, y: 0 },
        data: { label: "Session Start" },
        style: {
          background: "#f0fdf4",
          border: "1px solid #86efac",
          borderRadius: 8,
          fontSize: 12,
          padding: "8px 16px",
        },
      },
    ];

    const flowEdges: Edge[] = [];
    let prevId = "start";

    decisionNodes.forEach((dn, i) => {
      const nodeId = `decision_${i}`;

      flowNodes.push({
        id: nodeId,
        type: "default",
        position: { x: 250, y: (i + 1) * 120 },
        data: {
          label: (
            <div style={{ textAlign: "left", maxWidth: 200 }}>
              <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>
                {dn.resolved ? "✓" : "⏳"} {dn.event.context.slice(0, 60)}
                {dn.event.context.length > 60 ? "..." : ""}
              </div>
              {dn.selectedOptionTitle && (
                <div style={{ fontSize: 10, color: "#6b7280" }}>
                  → {dn.selectedOptionTitle}
                </div>
              )}
              <div style={{ fontSize: 10, color: "#9ca3af" }}>
                {dn.event.options.length} options
              </div>
            </div>
          ),
        },
        style: {
          background: dn.resolved ? "#f0fdf4" : "#fff1f2",
          border: `1px solid ${dn.resolved ? "#86efac" : "#fda4af"}`,
          borderRadius: 8,
          padding: "8px 12px",
          minWidth: 220,
        },
      });

      flowEdges.push({
        id: `e_${prevId}_${nodeId}`,
        source: prevId,
        target: nodeId,
        animated: !dn.resolved,
        style: { stroke: dn.resolved ? "#86efac" : "#fda4af" },
      });

      prevId = nodeId;
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [decisionNodes]);

  if (decisionNodes.length === 0) {
    return null;
  }

  return (
    <div className="h-64 border-t border-gray-200">
      <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-200">
        Decision Flow
      </div>
      <div style={{ height: "calc(100% - 28px)" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={true}
          zoomOnScroll={true}
          minZoom={0.5}
          maxZoom={1.5}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
