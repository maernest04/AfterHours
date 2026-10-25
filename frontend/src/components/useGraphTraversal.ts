import { useEffect, useRef, useState } from "react";
import type { CaseSnapshot } from "../data/reviewAdapter";
import { traversalFrames } from "../data/graphTraversal";

export const CHECKPOINT_DWELL_MS = 2200;
export function useGraphTraversal(live: CaseSnapshot, reducedMotion: boolean) {
  const [visible, setVisible] = useState(live);
  const previous = useRef(live);
  const latest = useRef(live);
  const queue = useRef<CaseSnapshot[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const old = previous.current;
    previous.current = live;
    latest.current = live;
    if (reducedMotion || live.connection === "demo" || live.blocker || live.status === "blocked" || live.status === "waiting" || old.runId !== live.runId || old.inputRevision !== live.inputRevision) {
      clearTimeout(timer.current); timer.current = undefined; queue.current = []; setVisible(live); return;
    }
    const frames = traversalFrames(old, live);
    queue.current.push(...frames);
    if (timer.current !== undefined) return;
    const advance = () => {
      const frame = queue.current.shift();
      if (!frame) { timer.current = undefined; setVisible(latest.current); return; }
      setVisible(frame);
      timer.current = setTimeout(advance, CHECKPOINT_DWELL_MS);
    };
    advance();
  }, [live, reducedMotion]);
  return visible;
}
