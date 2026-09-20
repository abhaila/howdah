/**
 * The two controls every resizable pane needs: the separator you drag, and the button that
 * opens and closes it. Geometry lives in `lib/panel.ts`; this file is only the surfaces.
 *
 * `PanelResizer` is a real `role="separator"` with `aria-valuenow`, focusable and operable by
 * arrows, so a pane is never mouse-only. When its panel is collapsed it drops out of the tab
 * order (`tabIndex -1`) rather than staying focusable with nothing to resize.
 *
 * Placement is the one thing these do NOT decide. The Steps panel learned this the hard way:
 * a control that positions itself against a zero-width lane resolves `left: 50%` to the lane's
 * edge and lands on top of its neighbour — the overlap howdah.css's lane comment describes.
 * So the resizer keeps a real width at all times and the toggle is static inside it.
 */
import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Panel } from "@/lib/panel";

export function PanelResizer({
  panel,
  label,
  className,
  disabled,
  children,
}: {
  panel: Panel;
  /** what the separator resizes, for assistive tech: "the detail panel" */
  label: string;
  className?: string;
  /**
   * There is nothing to resize right now — a full-width or closed panel. The lane stays (it
   * carries the way back), but it stops being draggable AND leaves the tab order: a separator
   * you can focus and drag with nothing on the other side is a control that lies.
   */
  disabled?: boolean;
  children?: ReactNode;
}) {
  const inert = disabled || panel.collapsed;
  return (
    <div
      className={cn("pane-resize", className)}
      role="separator"
      aria-orientation="vertical"
      aria-label={`resize ${label}`}
      aria-valuenow={inert ? 0 : panel.width}
      aria-valuemin={panel.min}
      tabIndex={inert ? -1 : 0}
      onPointerDown={inert ? undefined : panel.onPointerDown}
      onDoubleClick={inert ? undefined : panel.onDoubleClick}
      onKeyDown={inert ? undefined : panel.onKeyDown}
    >
      {children}
    </div>
  );
}

/**
 * The open/close control. `aria-expanded` is what tells a screen reader the state, and the
 * icon carries the same fact visually — a chevron that only changes direction is a state
 * nobody can name, so the icon says which side and which way.
 */
export function PanelToggle({
  panel,
  label,
  side = "right",
  className,
}: {
  panel: Panel;
  /** the pane's name, used in both the tooltip and the accessible label */
  label: string;
  side?: "left" | "right";
  className?: string;
}) {
  const Icon = side === "left"
    ? (panel.collapsed ? PanelLeftOpen : PanelLeftClose)
    : (panel.collapsed ? PanelRightOpen : PanelRightClose);
  const verb = panel.collapsed ? "Show" : "Hide";
  return (
    <Tooltip content={`${verb} ${label}`}>
      <Button
        variant="ghost"
        size="icon"
        className={cn("pane-toggle", className)}
        aria-expanded={!panel.collapsed}
        aria-label={`${verb} ${label}`}
        onPointerDown={(e) => e.stopPropagation()} /* inside a resizer this is a click, never a drag */
        onClick={panel.toggle}
      >
        <Icon size={13} />
      </Button>
    </Tooltip>
  );
}
