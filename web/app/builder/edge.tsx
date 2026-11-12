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
 *
 * HOW-68: the caption is a 28px control with 13px text (it was 10px on a 24px box), and the
 * two kinds of route no longer look alike. A CONDITION is machine text — the expression the
 * log prints — so it is mono in a solid box. "Otherwise" is a word, so it is sans in a dashed
 * box: told apart by face and by outline, not by colour. The selected route is ringed in the
 * accent, as the selected card is, rather than painted as a second primary button.
 *
 * WHERE the wire attaches and where the caption sits are `routing.ts`'s: sides chosen from the
 * two cards' positions, and a caption that is moved off any card it would cover.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { captionPoint, captionSize, cardFromHandle, type Side } from "./routing";

/** one caption's height plus a hairline of air, so two routes out of one side of a step stack
 *  instead of printing on each other */
const SIBLING_STEP = 30;
/** the card, for keeping a caption off it: its width, and a height no card exceeds */
const CARD = { width: 220, height: 76 };
const SIDE_OF: Record<Position, Side> = { [Position.Top]: "top", [Position.Right]: "right", [Position.Bottom]: "bottom", [Position.Left]: "left" };

export interface ConditionEdgeData extends Record<string, unknown> {
  /** the index in `spec.edges` — an edge's only identity (D5) */
  index: number;
  label: string;
  /** where this route sits among the routes leaving the SAME SIDE of the same step, and how
   *  many there are — two captions at one point is one unreadable smudge, so they are stacked */
  nth: number;
  siblings: number;
  /** whether the step this leaves has a branching problem, so the wire can say so */
  flagged: boolean;
  onOpen: () => void;
}

export function ConditionEdge(props: EdgeProps & { data?: ConditionEdgeData }) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props;
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  // Two routes leaving one side of one step share a gap, so their captions are spread around
  // the midpoint rather than stacked on it...
  const spread = data ? (data.nth - (data.siblings - 1) / 2) * SIBLING_STEP : 0;
  // ...and THE CAPTION NEVER SITS ON A CARD (HOW-68). The wire's sides are chosen from where
  // the two cards are (routing.ts), so its midpoint is normally in the gap between them; when
  // the caption is wider than that gap it moves across the wire until it is clear of both. The
  // cards are rebuilt from the handles React Flow gives this edge, so it holds mid-drag too.
  const from = SIDE_OF[sourcePosition], to = SIDE_OF[targetPosition];
  const sideways = from === "right" || from === "left" ? to === "left" || to === "right" : false;
  const at = captionPoint(
    { x: midX, y: midY + spread },
    captionSize(data?.label || "Otherwise"),
    [cardFromHandle({ x: sourceX, y: sourceY }, from, CARD.width, CARD.height), cardFromHandle({ x: targetX, y: targetY }, to, CARD.width, CARD.height)],
    sideways,
  );
  const conditional = !!data?.label;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={markerEnd} className={`gb-edge ${data?.flagged ? "needs-input" : ""}`} />
      <EdgeLabelRenderer>
        <div
          className="gb-edge-label nodrag nopan"
          // the only way to put a DOM label at a point on an SVG path: the renderer is one
          // absolutely-positioned layer, and each label says where in it it goes
          // ...and how high: above the cards, because on a hand-arranged graph a card can sit on a
          // wire's midpoint and a control under a card cannot be pressed — but under the SELECTED
          // card (React Flow lifts that to 1000), which is the thing being worked on, unless this
          // route is itself what is selected
          style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`, zIndex: selected ? 1001 : 1 }}
        >
          <Button
            variant="outline" size="sm"
            className={`${conditional ? "font-mono font-normal" : "border-dashed font-normal text-muted-foreground"} ${selected ? "gb-edge-on" : ""}`}
            aria-label={`Route ${data?.label || "otherwise"} — edit it`}
            aria-pressed={selected ?? false}
            onClick={data?.onOpen}
          >
            {data?.label || "Otherwise"}
          </Button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
