import { memo, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  useReactFlow,
  useViewport,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import {
  Check,
  Circle,
  Clock3,
  GitBranch,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Scan,
  X,
  AlertTriangle,
  PanelRightOpen,
} from "lucide-react";
import { regions, steps, links, edgeId, type Step } from "../data/topology";
import type { CaseSnapshot, NodeStatus } from "../data/reviewAdapter";
import "@xyflow/react/dist/style.css";
type WorkflowData = { step: Step; status: NodeStatus; onSelect: () => void };
const WorkflowNode = memo(
  ({ data, selected }: NodeProps<Node<WorkflowData>>) => {
    const { step, status } = data;
    const Icon =
      status === "complete"
        ? Check
        : status === "blocked"
          ? AlertTriangle
          : status === "running"
            ? GitBranch
            : status === "waiting"
              ? Clock3
              : Circle;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`${step.label}, ${status}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            data.onSelect();
          }
        }}
        className={`workflow-node ${status} ${step.kind ?? ""} ${selected ? "selected" : ""}`}
      >
        <Handle type="target" position={Position.Left} />
        <div className="node-heading">
          <span className="node-icon">
            <Icon size={15} />
          </span>
          <span>{step.label}</span>
        </div>
        <div className="node-meta">
          <span>{step.role}</span>
          <span>{status}</span>
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  },
);
const RegionNode = ({ data }: NodeProps<Node<{ name: string }>>) => (
  <div className="region-title">{data.name}</div>
);
const nodeTypes = { workflow: WorkflowNode, region: RegionNode };
function Graph({
  snapshot,
  selected,
  onSelect,
  expanded,
  onExpand,
  follow,
  onFollow,
  onInspector,
}: {
  snapshot: CaseSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  onExpand: () => void;
  follow: boolean;
  onFollow: () => void;
  onInspector: () => void;
}) {
  const { zoom } = useViewport();
  const { fitView, zoomIn, zoomOut, setCenter } = useReactFlow();
  const [reducedMotion] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const nodes = useMemo<Node[]>(
    () => [
      ...regions.map((r, i) => ({
        id: `region-${i}`,
        type: "region",
        position: { x: r.x, y: 15 },
        data: { name: r.name },
        style: { width: r.width, height: 820 },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
      })),
      ...steps.map((s) => ({
        id: s.id,
        type: "workflow",
        position: { x: s.x, y: s.y },
        data: {
          step: s,
          status: snapshot.nodeStates[s.id],
          onSelect: () => onSelect(s.id),
        },
        selected: s.id === selected,
        draggable: false,
        ariaLabel: `${s.label}, ${snapshot.nodeStates[s.id]}`,
      })),
    ],
    [snapshot.nodeStates, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      links.map((l) => {
        const id = edgeId(l.source, l.target);
        const done = snapshot.transitions.includes(id);
        const active =
          done &&
          snapshot.nodeStates[l.target] === "running" &&
          !snapshot.paused;
        return {
          id,
          source: l.source,
          target: l.target,
          label: l.label,
          type: "smoothstep",
          animated: active && !reducedMotion,
          style: {
            stroke: done ? "#418451" : "#c5cec1",
            strokeWidth: done ? 2.6 : 1.2,
            opacity: done ? 1 : 0.7,
          },
          labelStyle: { fontSize: 12, fill: done ? "#245b3b" : "#677461" },
          labelBgStyle: { fill: "#f7f9f4", fillOpacity: 0.94 },
          zIndex: done ? 1 : 0,
        };
      }),
    [snapshot.transitions, snapshot.nodeStates, snapshot.paused, reducedMotion],
  );
  const activeId = steps.find(
    (s) => snapshot.nodeStates[s.id] === "running",
  )?.id;
  useEffect(() => {
    if (follow && activeId) {
      const s = steps.find((x) => x.id === activeId)!;
      onSelect(activeId);
      void setCenter(s.x + 95, s.y + 40, {
        zoom: 0.95,
        duration: reducedMotion ? 0 : 300,
      });
    }
  }, [activeId, follow]);
  return (
    <>
      <div className="graph-toolbar">
        <div className="graph-title">
          <GitBranch size={17} />
          <strong>Review state machine</strong>
          <span>25 states · 3 AI roles</span>
        </div>
        <div className="graph-tools">
          <label className="follow">
            <input type="checkbox" checked={follow} onChange={onFollow} />
            Follow active step
          </label>
          <button
            title="Toggle step inspector"
            aria-label="Toggle step inspector"
            onClick={onInspector}
          >
            <PanelRightOpen size={16} />
          </button>
          <button
            onClick={onExpand}
            aria-label={expanded ? "Collapse graph" : "Expand graph"}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="graph-body">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) =>
            node.type === "workflow" && onSelect(node.id)
          }
          defaultViewport={{ x: 25, y: 10, zoom: 0.68 }}
          minZoom={0.3}
          maxZoom={1.8}
          nodesConnectable={false}
          nodesFocusable={false}
          nodesDraggable={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#ccd7c5" gap={20} size={1} />
        </ReactFlow>
        <div className="zoom-controls">
          <button aria-label="Zoom out" onClick={() => void zoomOut()}>
            <Minus size={16} />
          </button>
          <output aria-label="Graph zoom">{Math.round(zoom * 100)}%</output>
          <button aria-label="Zoom in" onClick={() => void zoomIn()}>
            <Plus size={16} />
          </button>
          <button
            onClick={() =>
              void fitView({ padding: 0.06, duration: reducedMotion ? 0 : 250 })
            }
          >
            <Scan size={15} />
            Fit graph
          </button>
        </div>
        <div className="pan-hint">
          Drag to pan · scroll to zoom · select any state
        </div>
      </div>
      <div className="graph-legend">
        {(
          [
            "dormant",
            "queued",
            "running",
            "complete",
            "waiting",
            "blocked",
            "skipped",
          ] as NodeStatus[]
        ).map((s) => (
          <span key={s}>
            <i className={s} />
            {s}
          </span>
        ))}
      </div>
    </>
  );
}
export function ExecutionGraph(props: Parameters<typeof Graph>[0]) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
export function CloseButton({
  onClick,
  label = "Close",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button className="icon-button" aria-label={label} onClick={onClick}>
      <X size={18} />
    </button>
  );
}
