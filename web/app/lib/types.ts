/** The read-model DTOs the screens share, out of main.tsx (HOW-16 P1). Shapes only. */
export interface AppInfo {
  home: string;
  runsDir: string;
  attentionDir: string;
  repoRoot: string;
  configPath: string;
  source: string;
  supervisorHeartbeat: string | null;
}

export interface GraphInfo {
  name: string; description: string; inputs: string[];
  kind: "repo" | "plain"; source: "builtin" | "local";
  /** HOW-22: the graph builder can re-open this one — it still carries the spec it was built from */
  builder: boolean;
  /** started only by this graph (HOW-57 implement-stacked ← plan-feature) — never offered in New run */
  launched_by?: string;
}
/** a local graph that will not load is reported beside the catalog, never silently missing */
export interface GraphProblem { name: string; error: string }
export interface GraphCatalog { graphs: GraphInfo[]; problems: GraphProblem[] }
export interface Workspaces { repos: Array<{ name: string; path: string }>; folders: Array<{ name: string; path: string }> }

export interface GhRepoDto { nameWithOwner: string; name: string; defaultBranch: string; isPrivate: boolean; updatedAt: string; localPath: string | null; registeredAs: string | null }

/** accept/reject/redraft changed the queue — the sidebar's pending count must follow */
export const PROPOSALS_CHANGED = "howdah:proposals-changed";
