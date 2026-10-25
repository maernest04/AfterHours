import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position,
  useReactFlow, useViewport, useNodesInitialized, type EdgeProps, type NodeProps, type Node, type Edge,
} from "@xyflow/react";
import {
  Check, Circle, Clock3, GitBranch, Maximize2, Minimize2, Minus, Plus, Scan,
  X, AlertTriangle, PanelRightOpen, PanelRightClose, ArrowLeft, ArrowUp, ArrowDown, ChevronRight,
} from "lucide-react";
import { steps, links, edgeId, type Step } from "../data/topology";
import { stages, stageStatus, type Stage } from "../data/stages";
import { routeAll, NODE_H, NODE_W } from "../data/layout";
import type { CaseSnapshot, NodeStatus } from "../data/reviewAdapter";
import { graphFocusStep } from "../data/graphFocus";
import "@xyflow/react/dist/style.css";

function StatusIcon({ status }: { status: NodeStatus }) {
  const Icon = status === "complete" ? Check : status === "blocked" ? AlertTriangle
    : status === "running" ? GitBranch : status === "waiting" ? Clock3 : Circle;
  return <span className="node-icon"><Icon size={17} /></span>;
}

type WorkflowData = { step: Step; status: NodeStatus; onSelect: () => void };
const WorkflowNode = memo(({ data, selected }: NodeProps<Node<WorkflowData>>) => (
  <button type="button" aria-label={`${data.step.label}, ${data.status}`}
    onClick={data.onSelect}
    onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onSelect(); }
    }}
    className={`workflow-node step-detail-node nodrag nopan ${data.status} ${data.step.kind ?? ""} ${selected ? "selected" : ""}`}>
    <Handle type="target" position={Position.Top} />
    <div className="node-heading"><StatusIcon status={data.status} /><span>{data.step.label}</span></div>
    <div className="node-meta"><span>{data.step.role}</span><span>{data.status}</span></div>
    <Handle type="source" position={Position.Bottom} />
  </button>
));

type StageData = { stage: Stage; status: NodeStatus; count: number; onOpen: () => void };
const StageNode = memo(({ data }: NodeProps<Node<StageData>>) => (
  <div className="stage-node-shell">
    <Handle type="target" position={Position.Top} />
    <button type="button" data-stage={data.stage.id}
      aria-label={`${data.stage.label}, ${data.status}. Show steps`}
      onClick={data.onOpen}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); data.onOpen(); }
      }}
      className={`workflow-node stage-node nodrag nopan ${data.status}`}>
      <div className="node-heading"><StatusIcon status={data.status} /><span>{data.stage.label}</span></div>
      <p>{data.stage.description}</p>
      <div className="stage-node-footer"><span>{data.status}</span><span>View {data.count} steps <ChevronRight size={14} /></span></div>
    </button>
    <Handle type="source" position={Position.Bottom} />
  </div>
));
const nodeTypes = { workflow: WorkflowNode, stage: StageNode };
type RouteData = { path: string; labelX: number; labelY: number; label?: string; done: boolean; active: boolean };
const RoutedEdge = ({ id, data, markerEnd, style }: EdgeProps<Edge<RouteData>>) => <>
  <BaseEdge id={id} path={data!.path} markerEnd={markerEnd} style={style} />
  {data!.active && <circle r={4} className="edge-pulse">
    <animateMotion dur="1.6s" repeatCount="indefinite" path={data!.path} />
  </circle>}
  {data!.label && <EdgeLabelRenderer>
    <div className={`edge-label ${data!.done ? "done" : ""}`}
      style={{ transform: `translate(-50%, -50%) translate(${data!.labelX}px, ${data!.labelY}px)` }}>
      {data!.label}
    </div>
  </EdgeLabelRenderer>}
</>;
const edgeTypes = { routed: RoutedEdge };
const routes = routeAll(steps, links);
const STAGE_W = 360;
const STAGE_H = 132;

function Graph({ snapshot, selected, onSelect, expanded, onExpand, follow, onFollow, onFollowStop, onStageChange, sidebarCollapsed, onSidebarToggle }: {
  snapshot: CaseSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  onExpand: () => void;
  follow: boolean;
  onFollow: () => void;
  onFollowStop: () => void;
  onStageChange: (follow: boolean) => void;
  sidebarCollapsed: boolean;
  onSidebarToggle: () => void;
}) {
  const [openStage, setOpenStage] = useState<Stage | null>(null);
  const stageIndex = stages.findIndex(stage => stage.id === openStage?.id);
  const previousStage = stages[stageIndex - 1];
  const nextStage = stages[stageIndex + 1];
  const navigateStage = (stage: Stage) => { onStageChange(false); setOpenStage(stage); };
  const { zoom } = useViewport();
  const { fitView, zoomIn, zoomOut, setCenter } = useReactFlow();
  // Include all rendered nodes when checking measurements; this graph has no hidden nodes.
  const nodesInitialized = useNodesInitialized({ includeHiddenNodes: true });
  const graphBody = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<string | null>(null);
  const fittedView = useRef<string | null>(null);
  const callbacks = useRef({ onSelect, onStageChange, onFollowStop });
  callbacks.current = { onSelect, onStageChange, onFollowStop };
  const [reducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const visibleSteps = useMemo(() => openStage ? steps.filter(step => step.region === openStage.region) : [], [openStage]);
  // Preserve the original flowchart geometry so branches, joins and retry paths retain their routing.
  const detailPositions = useMemo(() => Object.fromEntries(visibleSteps.map(step => [step.id,
    { x: step.x, y: step.y }])), [visibleSteps]);
  const nodes = useMemo<Node[]>(() => openStage ? visibleSteps.map(step => ({
    id: step.id, type: "workflow", position: detailPositions[step.id],
    data: { step, status: snapshot.nodeStates[step.id] ?? "dormant", onSelect: () => { callbacks.current.onFollowStop(); callbacks.current.onSelect(step.id); } },
    width: NODE_W, height: NODE_H,
    style: { width: NODE_W, height: NODE_H }, selected: selected === step.id,
    className: step.id === "calculate" ? "calculation-stage" : undefined,
  })) : stages.map((stage, index) => ({
    id: `stage-${stage.id}`, type: "stage", position: { x: 0, y: index * (STAGE_H + 34) },
    width: STAGE_W, height: STAGE_H,
    style: { width: STAGE_W, height: STAGE_H },
    data: { stage, status: stageStatus(stage, snapshot.nodeStates), count: steps.filter(step => step.region === stage.region).length,
      onOpen: () => { callbacks.current.onStageChange(true); setOpenStage(stage); } },
  })), [openStage, visibleSteps, detailPositions, snapshot.nodeStates, selected]);

  const edges = useMemo<Edge[]>(() => {
    if (openStage) {
      const ids = new Set(visibleSteps.map(step => step.id));
      return routes.filter(({ link }) => ids.has(link.source) && ids.has(link.target)).map(({ link, path, label }) => {
        const id = edgeId(link.source, link.target);
        const done = snapshot.transitions.includes(id);
        const active = done && snapshot.nodeStates[link.target] === "running" && !snapshot.paused && !reducedMotion;
        const color = done ? "#3f7f4f" : "#b9c5b2";
        return {
          id, source: link.source, target: link.target, type: "routed",
          data: { path, labelX: label.x, labelY: label.y, label: link.label, done, active },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          style: { stroke: color, strokeWidth: done ? 2.4 : 1.4, strokeDasharray: done ? undefined : "5 5" },
          selectable: false, focusable: false, zIndex: done ? 1 : 0,
        };
      });
    }
    return stages.slice(1).map((stage, index) => ({
    id: `stage-link-${index}`, source: `stage-${stages[index].id}`, target: `stage-${stage.id}`,
    type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "#9bac91", width: 16, height: 16 },
    style: { stroke: "#9bac91", strokeWidth: 1.5 }, selectable: false, focusable: false,
    }));
  }, [openStage, visibleSteps, snapshot.transitions, snapshot.nodeStates, snapshot.paused, reducedMotion]);

  const activeId = graphFocusStep(snapshot);
  useEffect(() => {
    if (!follow || !openStage || snapshot.status === "ready") return;
    const activeStep = steps.find(step => step.id === activeId);
    if (!activeStep) return;
    if (activeStep.region !== openStage.region) {
      callbacks.current.onStageChange(true);
      setOpenStage(stages.find(stage => stage.region === activeStep.region)!);
      return;
    }
    if (!nodesInitialized) return;
    const timer = requestAnimationFrame(() => {
      callbacks.current.onSelect(activeId);
      void setCenter(activeStep.x + NODE_W / 2, activeStep.y + NODE_H / 2,
        { zoom: 1, duration: reducedMotion ? 0 : 250 });
    });
    return () => cancelAnimationFrame(timer);
  }, [activeId, follow, openStage, nodesInitialized, snapshot.status, reducedMotion, setCenter]);

  useEffect(() => {
    if (!nodesInitialized) return;
    const view = `${openStage?.id ?? "overview"}:${expanded}:${sidebarCollapsed}`;
    if (fittedView.current === view) return;
    const timer = requestAnimationFrame(() => {
      fittedView.current = view;
      if (!(follow && openStage && snapshot.status !== "ready")) {
        void fitView({ padding: 0.14, minZoom: 0.2, maxZoom: 1, duration: 0 });
      }
      if (openStage) backButton.current?.focus();
      else if (returnFocus.current) {
        const button = graphBody.current?.querySelector<HTMLButtonElement>(`[data-stage="${returnFocus.current}"]`);
        if (button) { button.focus(); returnFocus.current = null; }
      }
    });
    return () => cancelAnimationFrame(timer);
  }, [openStage, expanded, sidebarCollapsed, fitView, nodesInitialized, follow, snapshot.status]);

  return <>
    <div className="graph-toolbar">
      <div className="graph-title">
        {openStage ? <button ref={backButton} className="stage-back" aria-label="Back to stages" onClick={() => {
          returnFocus.current = openStage.id;
          callbacks.current.onStageChange(false); setOpenStage(null);
        }}><ArrowLeft size={16} /> All stages</button> : <GitBranch size={17} />}
        <strong>{openStage ? openStage.label : "Review workflow"}</strong>
        <span>{openStage ? `${visibleSteps.length} steps` : "4 stages"}</span>
      </div>
      <div className="graph-tools">
        <label className="follow"><input type="checkbox" checked={follow} onChange={onFollow} />Follow active step</label>
        <button onClick={onExpand} aria-label={expanded ? "Collapse graph" : "Expand graph"}>
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button onClick={onSidebarToggle} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed} aria-controls="review-sidebar">
          {sidebarCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
      </div>
    </div>
    <div className={`graph-body ${openStage ? "stage-detail" : "stage-overview"}`} ref={graphBody}>
      <ReactFlow key={openStage?.id ?? "stages"} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        fitView fitViewOptions={{ padding: 0.14, minZoom: 0.2, maxZoom: 1 }} minZoom={0.2} maxZoom={1.8}
        nodesConnectable={false} nodesFocusable={false} nodesDraggable={false}
        onMoveStart={event => { if (event) onFollowStop(); }}
        onPaneClick={onFollowStop}
        zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}>
        <Background color="#ccd7c5" gap={20} size={1} />
      </ReactFlow>
      {openStage && <>
        <button className="stage-navigation previous" disabled={!previousStage}
          aria-label={previousStage ? `Previous stage: ${previousStage.label}` : "Previous stage"}
          title={previousStage ? `Previous stage: ${previousStage.label}` : "First stage"}
          onClick={() => previousStage && navigateStage(previousStage)}><ArrowUp size={18} /></button>
        <button className="stage-navigation next" disabled={!nextStage}
          aria-label={nextStage ? `Next stage: ${nextStage.label}` : "Next stage"}
          title={nextStage ? `Next stage: ${nextStage.label}` : "Last stage"}
          onClick={() => nextStage && navigateStage(nextStage)}><ArrowDown size={18} /></button>
      </>}
      <div className="zoom-controls">
        <button aria-label="Zoom out" onClick={() => { onFollowStop(); void zoomOut(); }}><Minus size={16} /></button>
        <output aria-label="Graph zoom">{Math.round(zoom * 100)}%</output>
        <button aria-label="Zoom in" onClick={() => { onFollowStop(); void zoomIn(); }}><Plus size={16} /></button>
        <button onClick={() => { onFollowStop(); void fitView({ padding: 0.14, maxZoom: 1, duration: reducedMotion ? 0 : 250 }); }}>
          <Scan size={15} /> Fit graph
        </button>
      </div>
      <div className="pan-hint">{openStage ? "Drag to pan · scroll to zoom" : "Select a stage to see its steps"}</div>
    </div>
    <div className="graph-legend">{(["dormant", "queued", "running", "complete", "waiting", "blocked", "skipped"] as NodeStatus[])
      .map(status => <span key={status}><i className={status} />{status}</span>)}</div>
  </>;
}

export function ExecutionGraph(props: Parameters<typeof Graph>[0]) {
  return <ReactFlowProvider><Graph key={props.snapshot.runId} {...props} /></ReactFlowProvider>;
}
export function CloseButton({ onClick, label = "Close" }: { onClick: () => void; label?: string }) {
  return <button className="icon-button" aria-label={label} onClick={onClick}><X size={18} /></button>;
}
