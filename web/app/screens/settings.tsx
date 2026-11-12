/**
 * Settings and workspace registration, out of main.tsx (HOW-16 P1).
 *
 * HOW-16 made the sound setting a real `Checkbox` and put removing a workspace behind an
 * AlertDialog that says what removing does NOT do: touch the files.
 *
 * HOW-68 redrew the screen as sections on the shared frame (screens/frame.tsx) — Editor,
 * Notifications and sound, Keyboard, Integrations, Workspaces — and cleared what the audit
 * measured here:
 *
 *   3.1.9  a workspace's PATH ran out of its card and under the remove button while its NAME
 *          was cut to "acm…". The name is now never cut (it wraps), the path is a `Truncate`
 *          cut in the middle — its distinguishing tail survives, the whole value shows on
 *          hover and focus — and a copy button gives it to the clipboard whole.
 *   3.5    the remove "×" was 14–16px wide. It is a 24px control with a name that says which
 *          workspace it removes.
 *   3.8    a `gh` failure was printed raw, in red, with no way forward. It is an inline error
 *          that says what Howdah was doing, what to run, and offers Retry; the tool's own
 *          words are kept, under it.
 *
 * Two controls are new, and both apply at once, in THIS browser, without Save:
 *
 *   Single-key shortcuts (WCAG 2.1.4): `lib/shortcuts.ts` owns the setting; this is its switch.
 *   Desktop notifications: shows the browser's permission as it is, and asks for it ONLY when
 *   "Enable desktop notifications" is pressed — never on load (DESIGN.md "Notifications and
 *   sound"). "Send a test notification" shows what one looks like.
 *
 * Everything else on the page is saved to config.json by the ONE primary action, Save, which
 * lives in the header so it is reachable however far the page has scrolled (⌘S / Ctrl S).
 */
import { useEffect, useState } from "react";
import { Bell, BellOff, Check, Copy, FolderGit2, GitBranch, Plus, RotateCw, Send, X } from "lucide-react";
import type { GhRepoDto, Workspaces } from "@/lib/types";
import { SETTINGS_CHANGED } from "@/lib/attention-sound";
import { notifyPermission, requestNotifyPermission, sendTestNotification, type NotifyPermission } from "@/lib/notify";
import { getJSON } from "@/lib/net";
import { useShortcuts, useSingleKeys } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertDialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { Truncate } from "@/components/ui/truncate";
import { useToast } from "@/components/ui/toast";
import { CODE, FieldError, Hint, LoadError, Screen, ScreenLoading, Section } from "./frame";

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
    <div data-slot="gh-picker" className="flex flex-col gap-2">
      <Label>
        Add a repository from GitHub
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your repositories, or type owner/name for any repository" />
      </Label>
      {error && (
        // the failure, said for a person: what Howdah was doing, what to do, and the tool's own words kept
        <div role="alert" data-slot="gh-error" className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-border bg-card p-3">
          <p className="m-0 text-sm font-medium text-destructive">GitHub could not be reached through the gh CLI.</p>
          <Hint>
            Howdah lists and clones repositories with <code className={CODE}>gh</code>. Run <code className={CODE}>gh auth login</code> in
            a terminal, then retry. A local folder can still be registered below.
          </Hint>
          <p className="m-0 whitespace-pre-wrap font-mono text-code text-muted-foreground [overflow-wrap:anywhere]">{error}</p>
          <Button variant="outline" size="sm" className="self-start" onClick={() => { setError(null); void load(query.includes("/") ? query : undefined); }}><RotateCw />Retry</Button>
        </div>
      )}
      {repos === null && !error && (
        <div role="status" aria-busy="true" className="flex flex-col gap-1.5">
          <span className="sr-only">Loading your repositories from GitHub</span>
          <Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" />
        </div>
      )}
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((r) => (
            <li key={r.nameWithOwner} className="flex min-h-9 items-center gap-3 border-b border-border py-1 text-sm">
              <Truncate mono className="flex-1 text-code text-foreground">{r.nameWithOwner}</Truncate>
              <span className="shrink-0 text-xs text-muted-foreground">
                {r.isPrivate ? "private" : "public"}
                {r.registeredAs ? ` · registered as ${r.registeredAs}` : r.localPath ? " · clone found" : " · will clone"}
              </span>
              {r.registeredAs
                ? <span className="inline-flex h-7 shrink-0 items-center gap-1 px-2 text-xs text-muted-foreground"><Check aria-hidden className="size-3.5" />Added</span>
                : <Button variant="outline" size="sm" disabled={busy !== null} loading={busy === r.nameWithOwner} onClick={() => add(r.nameWithOwner)} aria-label={`Add ${r.nameWithOwner}`}>
                    {busy !== r.nameWithOwner && <Plus />}{busy === r.nameWithOwner ? (r.localPath ? "Adding" : "Cloning") : "Add"}
                  </Button>}
            </li>
          ))}
        </ul>
      )}
      {repos !== null && shown.length === 0 && <Hint>No repository matches. Type <code className={CODE}>owner/name</code> to look one up directly.</Hint>}
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
    <div data-slot="add-workspace" className="flex flex-col gap-3">
      {hint && <Hint>{hint}</Hint>}
      <GithubRepoPicker onAdded={onAdded} />
      {!manual ? (
        <Hint>
          A plain folder (notes, docs, no git)?{" "}
          <Button variant="link" size="inline" onClick={() => setManual(true)}>Register a local path</Button>
        </Hint>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <Label className="min-w-[140px] flex-1">
              Name
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="notes" />
            </Label>
            <Label className="min-w-[220px] flex-[2]">
              Path
              <Input mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/notes" onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && path.trim() && !busy) void add(); }} />
            </Label>
            <Button variant="outline" onClick={add} loading={busy} disabled={!name.trim() || !path.trim()}>{!busy && <Plus />}Register</Button>
          </div>
          {error && <FieldError>{error}</FieldError>}
          <Hint>A git repository registers as a repo; any other folder registers as plain.</Hint>
        </div>
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

/** the browser's permission, in words, and what the operator can do about it */
const PERMISSION_COPY: Record<NotifyPermission, string> = {
  granted: "On. A run that starts waiting while this tab is in the background is announced with its name and what it is asking; clicking the notification opens the ask.",
  default: "Off. The browser has not been asked yet.",
  denied: "Blocked by the browser for this site. Allow notifications in the browser's site settings, then reload this page.",
  unsupported: "This browser cannot show notifications. The count beside “Needs you” and the tab's icon still change.",
};

function CopyPath({ what, text }: { what: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const name = copied ? `Copied the ${what} path` : `Copy the ${what} path`;
  return (
    <Tooltip content={name} side="left" align="center">
      <Button variant="ghost" size="icon-sm" aria-label={name} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

export function Settings() {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [ws, setWs] = useState<Workspaces | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotifyPermission>(() => notifyPermission());
  const [singleKeys, setSingleKeys] = useSingleKeys();
  const { toast } = useToast();
  const loadWs = () => getJSON<Workspaces>("/api/workspaces").then(setWs).catch(() => {});
  const removeWs = async (name: string) => {
    const r = await fetch("/api/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => null);
    setRemoving(null);
    toast(r?.ok ? `${name} is no longer registered — its files are untouched` : `could not remove ${name}`, r?.ok ? "default" : "error");
    loadWs();
  };
  const [failed, setFailed] = useState(false);
  const loadSettings = () => { setFailed(false); return getJSON<SettingsDto>("/api/settings").then(setS).catch(() => setFailed(true)); };
  useEffect(() => { void loadSettings(); loadWs(); }, []);
  const save = async () => {
    if (!s || saving) return;
    setSaving(true);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }).catch(() => null);
    // The key is write-only, so the screen cannot know the new state on its own: re-read it,
    // and drop whatever was typed so the box does not keep holding a credential.
    if (r?.ok) await getJSON<SettingsDto>("/api/settings").then(setS).catch(() => {});
    if (r?.ok) window.dispatchEvent(new Event(SETTINGS_CHANGED)); // the sound setting applies at once
    setSaving(false);
    toast(r?.ok ? "settings saved" : "could not save settings", r?.ok ? "default" : "error");
  };
  useShortcuts([{ id: "settings.save", scope: "Settings", label: "Save settings", keys: "mod+s", disabled: !s, run: () => void save() }]);
  if (!s) return failed ? <Screen name="settings" title="Settings" width="form"><LoadError what="your settings" onRetry={() => void loadSettings()} /></Screen> : <ScreenLoading name="settings" title="Settings" label="Loading settings" rows={5} />;

  const enableNotifications = async () => {
    const next = await requestNotifyPermission(); // the ONLY call site: a click, never a page load
    setPermission(next);
    if (next === "granted") toast("desktop notifications are on");
    else if (next === "denied") toast("the browser blocked notifications for this site", "error");
  };
  const testNotification = () => {
    if (!sendTestNotification()) toast("the browser would not show a notification", "error");
  };
  const workspaces = ws ? [...ws.repos.map((w) => ({ ...w, kind: "repo" as const })), ...ws.folders.map((w) => ({ ...w, kind: "plain" as const }))] : null;

  return (
    <Screen
      name="settings"
      title="Settings"
      width="form"
      actions={<Button onClick={save} loading={saving}>Save <Kbd keys="mod+s" decorative /></Button>}
    >
      <Section title="Editor">
        <Label>
          Editor command
          <Input mono value={s.editorCommand ?? ""} onChange={(e) => setS({ ...s, editorCommand: e.target.value })} placeholder="idea" />
        </Label>
        <Hint>What “Open in IDE” runs, with the worktree's path. It has to be on your PATH — for IntelliJ, Tools → Create Command-line Launcher.</Hint>
      </Section>

      <Section title="Notifications and sound">
        <div data-slot="notify-permission" data-permission={permission} className="flex flex-col gap-2">
          <div className="flex items-start gap-2 text-sm leading-5">
            {permission === "granted" ? <Bell aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <BellOff aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
            <p className="m-0"><span className="font-medium">Desktop notifications.</span> <span className="text-muted-foreground">{PERMISSION_COPY[permission]}</span></p>
          </div>
          <div className="flex flex-wrap gap-2">
            {permission === "default" && <Button variant="outline" size="sm" onClick={enableNotifications}><Bell />Enable desktop notifications</Button>}
            <Button variant="outline" size="sm" disabled={permission !== "granted"} onClick={testNotification}><Send />Send a test notification</Button>
          </div>
          <Hint>Applies at once, in this browser. With no viewer open, the terminal's own notification still fires.</Hint>
        </div>
        <Checkbox label="Play a sound when a run starts waiting on you" checked={s.chime === true} onChange={(e) => setS({ ...s, chime: e.target.checked })} />
        <Hint>Off unless you turn it on. It plays once per run that newly waits, never on navigation. Saved with Save.</Hint>
      </Section>

      <Section title="Keyboard">
        <Checkbox label="Single-key shortcuts" checked={singleKeys} onChange={(e) => setSingleKeys(e.target.checked)} />
        <Hint>
          Keys pressed alone, like <Kbd keys="c" /> for a new run or <Kbd keys="g r" /> for Runs. They are always ignored while you
          type in a field. Turn them off if stray keys or speech input trigger them: <Kbd keys="mod+k" /> still reaches every
          command, and <Kbd keys="?" /> lists them. Applies at once, in this browser.
        </Hint>
      </Section>

      <Section title="Integrations">
        <Label>
          Slack webhook
          <Input mono value={s.slackWebhook ?? ""} onChange={(e) => setS({ ...s, slackWebhook: e.target.value })} placeholder="https://hooks.slack.com/…" />
        </Label>
        <Hint>Where a run that needs you is sent as a direct message.</Hint>
        {s.typesafeApiKeyState === "env" ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-muted-foreground">TypeSafe API key</span>
            <Hint>Set by <code className={CODE}>TYPESAFE_API_KEY</code> in the environment, which wins over anything saved here.</Hint>
          </div>
        ) : (
          <Label>
            TypeSafe API key
            <Input
              mono
              type="password"
              autoComplete="off"
              value={s.typesafeApiKey ?? ""}
              onChange={(e) => setS({ ...s, typesafeApiKey: e.target.value })}
              placeholder={s.typesafeApiKeyState === "saved" ? "A key is saved. Type a new one to replace it" : "from console.typesafe.ai/keys"}
            />
          </Label>
        )}
        <Hint>
          Used for Jev decision calls.
          {s.typesafeApiKeyState === "saved" && (
            <>
              {" "}Howdah never shows a saved key back.{" "}
              <Button variant="link" size="inline" onClick={() => { setS({ ...s, typesafeApiKey: null }); }}>Clear it</Button>
              {s.typesafeApiKey === null && " — press Save to confirm."}
            </>
          )}
        </Hint>
      </Section>

      <Section title="Workspaces" count={workspaces?.length} description="The folders a run may work in. A repo gets worktrees, branches and pull requests; a plain folder is edited in place.">
        {workspaces === null ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-1.5"><span className="sr-only">Loading workspaces</span><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : workspaces.length === 0 ? (
          <Hint>No workspaces yet. Add a repository from GitHub or register a local folder below; a run needs one to work in.</Hint>
        ) : (
          <ul data-slot="workspaces" className="m-0 flex list-none flex-col p-0">
            {workspaces.map((w) => (
              <li key={w.name} data-workspace={w.name} className="flex min-h-9 items-center gap-3 border-b border-border py-1 text-sm">
                <Badge variant="outline" className="shrink-0">{w.kind === "repo" ? <GitBranch aria-hidden /> : <FolderGit2 aria-hidden />}{w.kind}</Badge>
                {/* the NAME is never cut: it is what a run is launched against, so it wraps instead */}
                <span data-col="name" className="max-w-[45%] shrink-0 text-body font-medium text-foreground [overflow-wrap:anywhere]">{w.name}</span>
                <Truncate mono middle={22} className="flex-1 text-code text-muted-foreground">{w.path}</Truncate>
                <CopyPath what={w.name} text={w.path} />
                <Tooltip content={`Remove ${w.name}`} side="left" align="center">
                  <Button variant="ghost" size="icon-sm" className="hover:text-destructive" aria-label={`remove the ${w.name} workspace`} onClick={() => setRemoving(w.name)}><X /></Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <AddWorkspace onAdded={loadWs} />
      </Section>

      <AlertDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removeWs(removing!)}
        title={`Remove ${removing ?? ""}?`}
        description="Howdah forgets this workspace, so no new run can choose it. The folder, its git history and any existing worktrees are left exactly as they are."
        confirmLabel="Remove the workspace"
      />
    </Screen>
  );
}
