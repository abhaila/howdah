/**
 * Message Scroller — shadcn/ui `message-scroller`, vendored from the `base-vega` style
 * (HOW-27). Provenance: `npx shadcn@latest add message-scroller`, kept verbatim apart from
 * the two `Button` defaults noted below.
 *
 * Why this one is allowed to be a dependency. It rides on `@shadcn/react`, which is 20KB with
 * ZERO runtime dependencies and `react` as its only peer — so the `No Radix, ever` rule is not
 * bent, it is satisfied: the `base`, `radix` and `aria` flavours of this file are byte-identical
 * apart from the button import, which is the proof that the primitive underneath is not a
 * primitives library. Nothing here imports `@base-ui/react`.
 *
 * What it buys is the part that is expensive to own and cheap to borrow, and that howdah's own
 * `.chat-log { overflow-y: auto }` did not have: the reader's position is HELD. Streaming
 * output keeps the live edge in view only while you are already at it; scrolling up to read
 * something pins there instead of being yanked back; and a turn boundary anchors with the
 * previous turn still peeking above it, so a new step does not arrive with no context. Those
 * are `ResizeObserver`/`IntersectionObserver` bookkeeping against a scroll container, which is
 * exactly the kind of thing that is wrong for months before anyone can say why.
 *
 * It imports `cn` from the `cn` package rather than `@/lib/utils` because that is what the
 * base-vega flavour ships, and a component pulled with `shadcn add` compiling unedited is the
 * contract `web/app/lib/utils.ts` exists to keep. The two merge helpers are the same idea
 * (`cn` is a zero-dependency clsx+tailwind-merge); consolidating the twenty older primitives
 * onto it belongs with the rest of the base-vega migration, not with this file.
 *
 * HOW-68 deviations, all three because DESIGN.md says so and each on the line it changes:
 *   - the root no longer sets `overflow-hidden`. It existed only to clip the inactive scroll
 *     pin, which the registry parks one button-height below the box; "overflow: hidden is for
 *     clipping corners, never for layout", and the viewport is this pane's ONE scroller.
 *   - so the inactive pin no longer travels out of the box, and it does not animate at all:
 *     it is there or it is not. It first faded and scaled in place over 150ms, and that
 *     entrance played every time the Build tab was switched to with a number key and every
 *     time `⌘I` resized the pane — "nothing keyboard-triggered animates", and a control that
 *     comes and goes with every scroll is the high-frequency case DESIGN.md names besides.
 *     (The registry's own exit was 400ms on an ease-IN curve.)
 *   - the viewport does not set `scrollbar-width` / `scrollbar-color`; tokens.css themes every
 *     scrollbar once.
 */
"use client"

import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ArrowDownIcon } from "lucide-react"

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        // Four of the registry's utilities here are `scrollbar-*`, which come from a Tailwind
        // scrollbar plugin the vendored shadcn layer does not carry, and `inset-s-*` on the
        // button below is not core Tailwind either. Verified against the real bundle rather
        // than assumed: `scroll-fade-b` and the `data-*` variants DO generate, those do not —
        // and an ungenerated utility is a class with no rule, which is the exact defect
        // css-contract.test.ts exists to catch. `scrollbar-gutter` is spelled as the arbitrary
        // property it stands for; the thumb's width and colour are tokens.css's (HOW-68).
        // `scroll-fade-y`, not the registry's `scroll-fade-b`: howdah renders BOTH pins (HOW-27),
        // and a pin floats over the transcript. With a fade on one edge only, the Top pin sat on
        // top of a row of live text with nothing softening it. The fade is edge-aware — it only
        // appears on a side there is more content to reach — so a short transcript still shows
        // neither pin and neither fade.
        "size-full min-h-0 min-w-0 scroll-fade-y [scrollbar-gutter:stable] overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-8", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

/**
 * The scroll-to-live-edge control. Two deviations from the registry's file, both because
 * howdah's `Button` has its own variant vocabulary (HOW-16 P1.3) rather than shadcn's:
 * `secondary` → `outline` and `icon-sm` → `icon`. Changing the DEFAULTS rather than adding
 * variants to `Button` keeps a shared primitive out of this ticket.
 */
function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "outline",
  size = "icon",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute start-1/2 -translate-x-1/2 border-border bg-background text-foreground hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:opacity-0 data-[active=true]:opacity-100 data-[direction=end]:bottom-3 data-[direction=start]:top-3 rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
