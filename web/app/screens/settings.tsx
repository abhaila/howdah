/**
 * Settings and workspace registration, out of main.tsx (HOW-16 P1).
 *
 * Two HOW-16 fixes are here. The attention chime was a raw
 * `<input type="checkbox" className="w-auto">` that inherited a text field's styling and had
 * no focus treatment of its own; it is a `Checkbox` with a real label association (P1.5).
 * And removing a workspace was a single un-asked click on an icon button — a destructive
 * verb with no confirmation surface anywhere in the app (P1.4). It asks now, through an
 * AlertDialog, and says in the dialog what removing does NOT do: touch the files.
 *
 * `.linkish` (a `<span onClick>`, keyboard-unreachable, P2.8) is a `Button variant="link"`.
 */
import { useEffect, useState } from "react";
import { GitBranch, FolderGit2, Plus, X } from "lucide-react";
import type { GhRepoDto, Workspaces } from "@/lib/types";
import { getJSON } from "@/lib/net";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertDialog } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

export function GithubRepoPicker({ onAdded }: { onAdded: () => void }) {
  const [repos, setRepos] = useState<GhRepoDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // nameWithOwner being registered
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const load = (q?: string) =>
    fetch(`/api/github/repos${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error((body as any).error);
        setRepos(body as GhRepoDto[]);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // owner/name queries hit gh directly (any accessible repo); plain text filters locally
    if (query.includes("/")) {
      const t = setTimeout(() => load(query), 400);
      return () => clearTimeout(t);
    }
  }, [query]);

  const add = async (nameWithOwner: string) => {
    setBusy(nameWithOwner);
    setError(null);
    try {
      const r = await fetch("/api/workspaces/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nameWithOwner }),
      });
      const body = (await r.json()) as any;
      if (!r.ok) throw new Error(body.error);
      toast(`${nameWithOwner} registered as a workspace`);
      onAdded();
      load();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
    } finally {
      setBusy(null);
    }
  };

  const shown = (repos ?? []).filter((r) => !query || query.includes("/") || r.nameWithOwner.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  return (
    <div className="gh-picker">
      <Input aria-label="search your GitHub repos" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your GitHub repos, or type owner/name for any repo…" />
      {error && <div className="field-error">{error}</div>}
      {repos === null && !error && <div className="field-hint">loading your repos from GitHub…</div>}
      {shown.map((r) => (
        <div key={r.nameWithOwner} className="gh-repo-row">
          <span className="run-goal">{r.nameWithOwner}</span>
          <span className="gh-meta">
            {r.isPrivate ? "private" : "public"}
            {r.registeredAs ? ` · registered as ${r.registeredAs}` : r.localPath ? " · clone found" : " · will clone"}
          </span>
          {r.registeredAs
            ? <span className="gh-added" aria-label="already registered">✓</span>
            : <Button size="sm" disabled={busy !== null} onClick={() => add(r.nameWithOwner)}>
                <Plus />{busy === r.nameWithOwner ? (r.localPath ? "Adding…" : "Cloning…") : "Add"}
              </Button>}
        </div>
      ))}
      {repos !== null && shown.length === 0 && <div className="field-hint">no matches — try owner/name</div>}
    </div>
  );
}

export function AddWorkspace({ onAdded, hint }: { onAdded: () => void; hint?: string }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const { toast } = useToast();
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, path }),
      });
      const body = (await r.json()) as any;
      if (!r.ok) throw new Error(body.error ?? "failed");
      toast(`${name} registered as a workspace`);
      setName("");
      setPath("");
      onAdded();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="add-workspace">
      {hint && <div className="field-hint">{hint}</div>}
      <GithubRepoPicker onAdded={onAdded} />
      {!manual ? (
        <div className="field-hint">
          Plain folder (notes, docs — no git)?{" "}
          <Button variant="link" size="inline" onClick={() => setManual(true)}>register a local path</Button>
        </div>
      ) : (
        <>
          <div className="add-workspace-row">
            <Input aria-label="workspace name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. notes)" className="flex-1" />
            <Input aria-label="workspace path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/notes or /Users/areeb/…" className="flex-[2]" />
            <Button onClick={add} disabled={busy || !name.trim() || !path.trim()}><Plus />{busy ? "…" : "Add"}</Button>
          </div>
          {error && <div className="field-error">{error}</div>}
          <div className="field-hint">A git repo registers as a repo; any other folder registers as Plain.</div>
        </>
      )}
    </div>
  );
}

interface SettingsDto {
  editorCommand?: string;
  slackWebhook?: string;
  chime?: boolean;
  /** the key itself is never served back — only whether one is in force, and from where */
  typesafeApiKeyState?: "env" | "saved" | "unset";
  /** write-only: what the operator just typed. Blank means "leave it"; null means "clear it". */
  typesafeApiKey?: string | null;
}

export function Settings() {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [saved, setSaved] = useState(false);
  const [ws, setWs] = useState<Workspaces>({ repos: [], folders: [] });
  const [removing, setRemoving] = useState<string | null>(null);
  const { toast } = useToast();
  const loadWs = () => getJSON<Workspaces>("/api/workspaces").then(setWs).catch(() => {});
  const removeWs = async (name: string) => {
    const r = await fetch("/api/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => null);
    setRemoving(null);
    toast(r?.ok ? `${name} is no longer registered — its files are untouched` : `could not remove ${name}`, r?.ok ? "default" : "error");
    loadWs();
  };
  useEffect(() => { getJSON<SettingsDto>("/api/settings").then(setS).catch(() => {}); loadWs(); }, []);
  if (!s) return <LoadingBlock label="Loading settings" rows={3} />;
  const save = async () => {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }).catch(() => null);
    // The key is write-only, so the screen cannot know the new state on its own: re-read it,
    // and drop whatever was typed so the box does not keep holding a credential.
    if (r?.ok) await getJSON<SettingsDto>("/api/settings").then(setS).catch(() => {});
    setSaved(true);
    toast(r?.ok ? "settings saved" : "could not save settings", r?.ok ? "default" : "error");
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="runs">
      <h1>Settings</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
          <Label>
            Editor command (Open-in-IDE)
            <Input value={s.editorCommand ?? ""} onChange={(e) => setS({ ...s, editorCommand: e.target.value })} placeholder="idea — IntelliJ launcher on PATH (Tools → Create Command-line Launcher)" />
          </Label>
          <Label>
            Slack webhook (attention DMs)
            <Input value={s.slackWebhook ?? ""} onChange={(e) => setS({ ...s, slackWebhook: e.target.value })} placeholder="https://hooks.slack.com/…" />
          </Label>
          <Label>
            TypeSafe API key (Jev decision calls)
            {s.typesafeApiKeyState === "env" ? (
              <div className="field-hint">
                Set by <code>TYPESAFE_API_KEY</code> in the environment, which wins over anything saved here.
              </div>
            ) : (
              <Input
                type="password"
                value={s.typesafeApiKey ?? ""}
                onChange={(e) => setS({ ...s, typesafeApiKey: e.target.value })}
                placeholder={s.typesafeApiKeyState === "saved" ? "A key is saved — type a new one to replace it" : "console.typesafe.ai/keys"}
              />
            )}
          </Label>
          {s.typesafeApiKeyState === "saved" && (
            <div className="field-hint">
              Howdah never shows a saved key back.{" "}
              <Button variant="link" size="inline" onClick={() => { setS({ ...s, typesafeApiKey: null }); }}>Clear it</Button>
              {s.typesafeApiKey === null && " — press Save to confirm."}
            </div>
          )}
          <Checkbox label="Attention chime" checked={s.chime !== false} onChange={(e) => setS({ ...s, chime: e.target.checked })} />
          <Button onClick={save} className="self-start">{saved ? "Saved" : "Save"}</Button>
        </CardContent>
      </Card>

      <h1 className="section-gap">Workspaces</h1>
      <Card className="max-w-[640px]">
        <CardContent className="pt-5">
          {[...ws.repos.map((w) => ({ ...w, kind: "repo" })), ...ws.folders.map((w) => ({ ...w, kind: "plain" }))].map((w) => (
            <div key={w.name} className="ws-row">
              <Badge variant="outline">{w.kind === "repo" ? <GitBranch /> : <FolderGit2 />}{w.kind}</Badge>
              <span className="run-goal">{w.name}</span>
              <Tooltip content={w.path}><span className="run-meta">{w.path}</span></Tooltip>
              <Button variant="ghost" size="icon" className="ml-auto size-6 text-faint hover:text-destructive" aria-label={`remove the ${w.name} workspace`} onClick={() => setRemoving(w.name)}><X /></Button>
            </div>
          ))}
          {ws.repos.length + ws.folders.length === 0 && <div className="field-hint">No workspaces yet.</div>}
          <AddWorkspace onAdded={loadWs} />
        </CardContent>
      </Card>

      <AlertDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removeWs(removing!)}
        title={`Remove ${removing ?? ""}?`}
        description="Howdah forgets this workspace, so no new run can choose it. The folder, its git history and any existing worktrees are left exactly as they are."
        confirmLabel="Remove the workspace"
      />
    </div>
  );
}
