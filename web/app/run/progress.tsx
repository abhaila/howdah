/**
 * HOW-49: "where is it at?" — the live progress panel for a running step.
 *
 * Watching a long implement step, the run page answered "what is it doing?" (115 tool calls)
 * but not what is DONE, what is NEXT, or whether it is still MAKING PROGRESS. cwc's answer is a
 * tmux grid of `watch` panes over what lands on disk; this is the same idea drawn from what
 * Howdah already has, with nothing new stored:
 *
 *   - the agent's own plan, from its latest TodoWrite (derive.ts derivePlan) — no prompt
 *     change and no PROGRESS.md sidecar; a harness that reports no plan says so rather than
 *     showing an invented one;
 *   - commits and dirty files made DURING the step, from the server's live, read-only git
 *     probe (web/live-git.ts), pushed over the run's SSE stream as `git-live`;
 *   - liveness, the time since the agent last produced anything, amber past QUIET_MS — the
 *     same rule the turn note and the runs board use (lib/liveness.ts).
 *
 * It renders only while the newest step's turn is LIVE (derive.ts turn_states), pinned at the
 * top of Chat and as a section of the rail. A finished step's story is the transcript.
 */
import { CheckCircle2, Circle, CircleDot, GitCommitHorizontal, ListChecks } from "lucide-react";
import type { RunDetail } from "../../derive";
import type { LiveGit } from "../../live-git";
import { useNow } from "@/lib/hooks";
import { fmtAgo, liveness } from "@/lib/liveness";

/** the newest step, when its turn is live — the only time the panel has anything to say */
export function liveStep(detail: Pick<RunDetail, "timeline" | "turn_states">): { node: string; visit: number } | null {
  const row = detail.timeline.at(-1);
  if (!row) return null;
  return detail.turn_states[`${row.node}@${row.visit}`] === "live" ? { node: row.node, visit: row.visit } : null;
}

const STATUS_ICON = { completed: CheckCircle2, in_progress: CircleDot, pending: Circle } as const;
const ago = (iso: string, now: number) => fmtAgo(now - new Date(iso).getTime());

export function ProgressPanel({ detail, liveGit, variant = "pinned" }: {
  detail: RunDetail;
  /** the latest `git-live` push for this run, or null before the first one arrives */
  liveGit: LiveGit | null;
  variant?: "pinned" | "rail";
}) {
  const now = useNow();
  const step = liveStep(detail);
  if (!step) return null;
  const plan = detail.plan && detail.plan.node === step.node && detail.plan.visit === step.visit ? detail.plan : null;
  const harness = detail.renders.findLast((r) => r.node === step.node && r.visit === step.visit)?.harness ?? "claude";
  const { ageMs, quiet } = liveness(detail.last_agent_event_at, now);
  // a push for an earlier step is history, not this step's progress
  const git = liveGit && liveGit.node === step.node && liveGit.visit === step.visit ? liveGit : null;
  const done = plan?.items.filter((i) => i.status === "completed").length ?? 0;

  return (
    <section className="progress-panel" data-variant={variant} aria-label="Live progress">
      <div className="pp-head">
        <span className="pp-step">{step.node}@{step.visit}</span>
        <span className="pp-live" data-quiet={quiet ? "true" : "false"}>
          working{ageMs !== null && <> · last activity {fmtAgo(ageMs)} ago</>}
          {quiet && <> — quiet for a while</>}
        </span>
      </div>

      <div className="pp-block">
        <div className="pp-label"><ListChecks size={12} aria-hidden /> Plan{plan && plan.items.length > 0 && <> · {done} of {plan.items.length} done</>}</div>
        {plan && plan.items.length > 0 ? (
          <ul className="pp-plan">
            {plan.items.map((item, i) => {
              const Icon = STATUS_ICON[item.status];
              return (
                <li key={i} className="pp-item" data-status={item.status}>
                  <Icon size={12} aria-hidden />
                  <span>{item.content}</span>
                  <span className="sr-only">({item.status.replace("_", " ")})</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="pp-empty">{harness === "claude" ? "no plan reported yet" : "no plan reported by this harness"}</div>
        )}
      </div>

      <div className="pp-block">
        <div className="pp-label"><GitCommitHorizontal size={12} aria-hidden /> Worktree</div>
        {git ? (
          <>
            <div className="pp-git">
              <span>{git.commit_count} commit{git.commit_count === 1 ? "" : "s"} this step</span>
              <span>{git.uncommitted} uncommitted file{git.uncommitted === 1 ? "" : "s"}</span>
              <span>{git.last_commit_at ? <>last commit {ago(git.last_commit_at, now)} ago</> : "no commits yet"}</span>
            </div>
            {git.commits.length > 0 && (
              <ul className="pp-commits">
                {git.commits.slice(0, 5).map((c) => (
                  <li key={c.sha} className="pp-commit">
                    <span className="m">{c.sha}</span>
                    <span className="pp-subject">{c.subject}</span>
                    <span className="pp-age">{ago(c.at, now)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="pp-empty">probed {ago(git.probed_at, now)} ago</div>
          </>
        ) : (
          <div className="pp-empty">worktree not probed yet</div>
        )}
      </div>
    </section>
  );
}
