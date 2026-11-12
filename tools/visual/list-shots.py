import os,re
S='shots'
names=sorted(f[:-4] for f in os.listdir(S) if f.endswith('.png'))
RUNS=[('run-needs-input-prose','needs-input run, long prose ask (acceptance-unmet at delivery.publish; reply refused → "Retry this step")'),
('run-needs-input-long-id-name','needs-input run with a 100-char id and a 150-char name (replyable attempt-failed, long reason)'),
('run-needs-input-question','needs-input run parked on a harness AskUserQuestion (2 questions with options)'),
('run-needs-input-ambiguous-effect','needs-input run parked on an ambiguous side effect (create-pr)'),
('run-needs-input-max-visits-no-reply','needs-input run parked on max-visits (reply refused, failing verify)'),
('run-needs-input-harness-unauthenticated','needs-input run parked harness-unauthenticated (codex)'),
('run-needs-input-stuck','needs-input run parked stuck (8 identical failing calls)'),
('run-plan-feature-awaiting-approval','plan-feature run awaiting approval (round 2, pinned comments)'),
('run-plan-feature-parent-with-children','plan-feature parent that launched 3 child runs'),
('run-implement-slice-awaiting-approval','implement-slice run awaiting approval (ghosts on the map)'),
('run-child-stacked','implement-stacked child run, open step with a dead runner'),
('run-draft-graph-ready','draft-graph run with a ready draft'),('run-draft-graph-saved','draft-graph run whose draft was saved'),
('run-research-done','finished research run (codex turns, long markdown output)'),
('run-harness-dead','write-doc run: open step, dead runner (harness dead)'),
('run-failed','run finished failed (worktree retained)'),('run-aborted','run finished aborted (PR closed)'),
('run-live','LIVE run (real runner, streaming)'),('run-paused','run paused by the operator'),('run-unknown-id','/run/<unknown id> empty state'),
('run-done','finished implement-ticket run (acceptance, evidence, PR, plan, change map)')]
PANE={'build-chat-tools-expanded':'Build (chat) pane, all tool calls expanded','build-chat-top':'Build (chat) pane scrolled to the start','build-chat':'Build (chat) pane, default view (scrolled to latest)',
'build-inspector-hidden':'Build pane with the inspector rail hidden','inspector-scrolled-bottom':'inspector rail scrolled to its end','inspector-children':'inspector rail scrolled to the child-runs list',
'plan':'Plan tab','report':'Report tab (self-contained HTML in an iframe)','steps-default':'Steps tab, default selection','steps':'Steps tab',
'steps-step-selected-activity':'Steps tab, implementation.implement selected — Activity','steps-step-selected-ask':'… — Ask sub-tab','steps-step-selected-prompt-context':'… — Prompt & context sub-tab','steps-step-selected-output':'… — Output sub-tab','steps-step-selected':'Steps tab with a step selected',
'steps-run-scope':'Steps tab, scope switched Step → Run','steps-detail-full-width':'Steps tab, detail panel expanded to full width',
'context':'Context tab','context-key-selected':'Context tab, implementation_plan selected','context-document':'Context tab, long markdown value selected','logs':'Logs tab','logs-row-selected':'Logs tab, a row selected','graph':'Graph tab (run DAG)',
'card':'the standing-ask card scrolled into view','toast-copied':'toast after "Copy resume"','toast-open-ide':'toast after "Open in IDE"','ask-composer-typed':'the read-only Ask composer with text typed','header-controls':'header controls of a live run (stop / abort)',
'steps-approve-approval':'Steps → approval step → Approval pane','steps-approve-map':'Steps → approval step → Map pane','steps-approve-activity':'Steps → approval step → Activity','steps-approve-prompt-context':'Steps → approval step → Prompt & context','steps-approve-output':'Steps → approval step → Output',
'steps-approval-full-width':'approval pane at full width','steps-approval-full-width-bottom':'approval pane at full width, scrolled down','steps-approval-pin-comment-open':'approval pane, "pin a comment" form open','steps-approval-redesign-open':'approval pane, Redesign form open'}
TOP={'runs-list':'Runs list (the board), top','runs-list-bottom':'Runs list scrolled to the end','runs-list-hover-long-name':'Runs list, hovering the row with the 150-char name','runs-list-nav-collapsed':'Runs list with the nav collapsed to a rail',
'attention-inbox':'Needs you (attention inbox) + Ready for you','new-run-empty':'New run, nothing chosen','new-run-implement-ticket':'New run, implement-ticket chosen','new-run-draft-graph':'New run, draft-graph chosen',
'graphs-list':'Graphs, nothing selected','graphs-implement-ticket-selected':'Graphs, built-in implement-ticket selected (shape + tuning)','graphs-local-triage-bug-selected':'Graphs, local graph triage-bug selected','graphs-scrolled-bottom':'Graphs, scrolled to the end',
'builder-new':'Graph builder, new graph','builder-existing-graph-panel':'Graph builder, triage-bug, graph panel','builder-existing-step-selected':'Graph builder, a step selected (properties panel)','builder-existing-step-selected-panel-bottom':'… properties panel scrolled to its end','builder-existing-route-selected':'Graph builder, a route (edge) selected','builder-existing-finish-step-selected':'Graph builder, a Finish step selected','builder-from-draft-run':'Graph builder opened from a draft run (?fromRun=)',
'prompts-list':'Prompts, list','prompts-detail-delivery-publish':'Prompts, delivery.publish detail','prompts-detail-scrolled-bottom':'… scrolled to the end','prompts-detail-partial':'Prompts, a partial (_plan_first)','proposals-list-first-selected':'Proposals, first (pending) proposal selected','proposals-pending-selected':'Proposals, the pending proposal by URL',
'settings':'Settings','settings-scrolled-bottom':'Settings scrolled to the end','settings-register-path-form':'Settings, "register a local path" form open',
'draft-review-ready':'Draft review page, ready draft','draft-review-saved':'Draft review page, saved draft','draft-review-run-without-draft':'Draft review page for a run with no draft',
'defect-inspector-toggle-under-resizer':'crop: inspector toggle with the resizer hovered (defect evidence)'}
rows=[]
for n in names:
    m=re.match(r'(dark|light)-(.*?)(-1024x700)?$',n); theme,slug,narrow=m.group(1),m.group(2),m.group(3)
    d=None
    if slug.startswith('dialog-'): d='DIALOG: '+slug[7:].replace('-',' ')+' (Escape closes it — see shots/dialogs.json)'
    elif slug.startswith('focus-'): d='crop: keyboard focus on '+slug[6:].replace('-',' ')
    elif slug in TOP: d=TOP[slug]
    else:
        for key,desc in RUNS:
            if slug==key: d=desc; break
            if slug.startswith(key+'-'):
                rest=slug[len(key)+1:]; d=f"{desc} — {PANE.get(rest, rest.replace('-',' '))}"; break
    rows.append(f"| `{n}.png` | {theme} | {'1024×700' if narrow else '1440×900'} | {d or slug.replace('-',' ')} |")
open('shots/SHOTS.md','w').write("| file | theme | viewport | what |\n|---|---|---|---|\n"+'\n'.join(rows)+'\n')
print(len(rows))
