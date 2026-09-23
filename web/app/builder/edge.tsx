/**
 * One route, as a wire (HOW-24).
 *
 * The caption is `predicateLabel(when)` — the SAME string the compiled graph's `Condition`
 * carries and the event log prints (`review_verdict == 'reject'`). So the picture, the run's
 * own DAG and the log all read identically; a builder that invented friendlier wording here
 * would be the third spelling of one fact.
 *
 * The caption is a `Button`, not a `<text>`: a wire is a hairline and a hairline is not a
 * click target, and a route has to be reachable without a mouse at all (D7). Pressing it
 * selects the route, which is what opens its condition in the panel.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { Button } from "@/components/ui/button";

/** half a card's width plus a gap: far enough left of the column to clear every box in it */
const BACK_EDGE_OFFSET = 140;
/** one caption's height, so two routes out of one step stack instead of printing on each other */
const SIBLING_STEP = 24;

export interface ConditionEdgeData extends Record<string, unknown> {
  /** the index in `spec.edges` — an edge's only identity (D5) */
  index: number;
  label: string;
  /** where this route sits among the routes leaving the SAME step, and how many there are —
   *  two captions at one point is one unreadable smudge, so they are stacked */
  nth: number;
  siblings: number;
  /** whether the step this leaves has a branching problem, so the wire can say so */
  flagged: boolean;
  onOpen: () => void;
}

export function ConditionEdge(props: EdgeProps & { data?: ConditionEdgeData }) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props;
  const [path, midX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  // A LOOP BACK UP SHARES ITS GAP WITH THE ROUTE THAT CAME DOWN, and two captions at the same
  // point are one unreadable smudge. The read-only picture curves a back edge around the LEFT
  // of the column (graph-dag.tsx); this says the same thing with the caption alone.
  const labelX = targetY < sourceY ? Math.min(sourceX, targetX) - BACK_EDGE_OFFSET : midX;
  // ...and two routes leaving one step share the same gap, so their captions are spread around
  // the midpoint rather than stacked on it
  const spread = data ? (data.nth - (data.siblings - 1) / 2) * SIBLING_STEP : 0;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={markerEnd} className={`gb-edge ${data?.flagged ? "needs-input" : ""}`} />
      <EdgeLabelRenderer>
        <div
          className="gb-edge-label nodrag nopan"
          // the only way to put a DOM label at a point on an SVG path: the renderer is one
          // absolutely-positioned layer, and each label says where in it it goes
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + spread}px)` }}
        >
          <Button
            variant={selected ? "default" : "outline"} size="sm"
            aria-label={`Route ${data?.label || "otherwise"} — edit it`}
            onClick={data?.onOpen}
          >
            {data?.label || "otherwise"}
          </Button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
