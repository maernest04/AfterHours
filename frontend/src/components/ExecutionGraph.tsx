import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  useReactFlow,
  useViewport,
  type EdgeProps,
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
import { routeAll, NODE_H, NODE_W } from "../data/layout";
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
type RouteData = {
  path: string;
  labelX: number;
  labelY: number;
  label?: string;
  done: boolean;
  active: boolean;
  travelling: boolean;
};
/** How long the dot takes to travel an edge before the target box lights up. */
export const TRAVEL_MS = 700;
// Paths are precomputed by data/layout.ts (smooth curves that avoid every node).
const RoutedEdge = ({ id, data, markerEnd, style }: EdgeProps<Edge<RouteData>>) => (
  <>
    <BaseEdge id={id} path={data!.path} markerEnd={markerEnd} style={style} />
    {data!.travelling && (
      <circle r={5} className="edge-pulse travelling">
        <animateMotion dur={`${TRAVEL_MS}ms`} repeatCount="1" fill="freeze" path={data!.path} />
      </circle>
    )}
    {data!.active && (
      <circle r={4} className="edge-pulse">
        <animateMotion dur="1.6s" repeatCount="indefinite" path={data!.path} />
      </circle>
    )}
    {data!.label && (
      <EdgeLabelRenderer>
        <div
          className={`edge-label ${data!.done ? "done" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${data!.labelX}px, ${data!.labelY}px)` }}
        >
          {data!.label}
        </div>
      </EdgeLabelRenderer>
    )}
  </>
);
const edgeTypes = { routed: RoutedEdge };
const routes = routeAll(steps, links);
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
  // A newly traversed edge first carries a dot to its target; the target box keeps
  // its previous look until the dot arrives, then lights up.
  const [travelling, setTravelling] = useState<string[]>([]);
  const seen = useRef<string[]>(snapshot.transitions);
  const shown = useRef<Record<string, NodeStatus>>({ ...snapshot.nodeStates });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const fresh = snapshot.transitions.filter((t) => !seen.current.includes(t));
    seen.current = snapshot.transitions;
    if (!fresh.length || reducedMotion) return;
    setTravelling((t) => [...t, ...fresh]);
    timers.current.push(
      setTimeout(() => setTravelling((t) => t.filter((x) => !fresh.includes(x))), TRAVEL_MS),
    );
  }, [snapshot.transitions, reducedMotion]);
  // Include edges traversed in this very render so the box never flashes early.
  const fresh = reducedMotion ? [] : snapshot.transitions.filter((t) => !seen.current.includes(t));
  const arriving = new Set([...travelling, ...fresh].map((t) => t.split(":")[1]));
  const status = (id: string): NodeStatus =>
    arriving.has(id) ? (shown.current[id] ?? "dormant") : snapshot.nodeStates[id];
  useEffect(() => {
    for (const s of steps) if (!arriving.has(s.id)) shown.current[s.id] = snapshot.nodeStates[s.id];
  });
  const nodeKey = steps.map((s) => status(s.id)).join();
  const nodes = useMemo<Node[]>(
    () => [
      ...regions.map((r, i) => ({
        id: `region-${i}`,
        type: "region",
        position: { x: r.x, y: r.y },
        data: { name: r.name },
        style: { width: r.width, height: r.height },
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
          status: status(s.id),
          onSelect: () => onSelect(s.id),
        },
        selected: s.id === selected,
        draggable: false,
        ariaLabel: `${s.label}, ${status(s.id)}`,
      })),
    ],
    [nodeKey, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      routes.map(({ link: l, path, label }) => {
        const id = edgeId(l.source, l.target);
        const done = snapshot.transitions.includes(id);
        const moving = travelling.includes(id) || fresh.includes(id);
        const active =
          done &&
          !moving &&
          snapshot.nodeStates[l.target] === "running" &&
          !snapshot.paused &&
          !reducedMotion;
        const color = done ? "#3f7f4f" : "#b9c5b2";
        return {
          id,
          source: l.source,
          target: l.target,
          type: "routed",
          data: { path, labelX: label.x, labelY: label.y, label: l.label, done, active, travelling: moving },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          style: {
            stroke: color,
            strokeWidth: done ? 2.4 : 1.4,
            strokeDasharray: done ? undefined : "5 5",
          },
          zIndex: done ? 1 : 0,
        };
      }),
    [snapshot.transitions, snapshot.nodeStates, snapshot.paused, travelling, fresh.join(), reducedMotion],
  );
  const activeId = steps.find(
    (s) => snapshot.nodeStates[s.id] === "running",
  )?.id;
  useEffect(() => {
    if (follow && activeId) {
      const s = steps.find((x) => x.id === activeId)!;
      onSelect(activeId);
      void setCenter(s.x + NODE_W / 2, s.y + NODE_H / 2, {
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
          <span>{steps.length} states · 3 AI roles</span>
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
          edgeTypes={edgeTypes}
          onNodeClick={(_, node) =>
            node.type === "workflow" && onSelect(node.id)
          }
          defaultViewport={{ x: 280, y: 10, zoom: 0.75 }}
          minZoom={0.15}
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
