"""Turn shots/audit.json into shots/audit-summary.md, and judge it.

Run from $HOWDAH_VISUAL_OUT. The last thing printed is the STANDARDS block — the HOW-68 loop's
gate (docs/designs/design-overhaul.md "Minimum standards"). It exits 1 when any count is not
zero, so a capture that regressed cannot be read as a pass.
"""
import json,collections,sys,os
A=json.load(open("shots/audit.json"))
out=[]
P=out.append
# fonts
fam=collections.defaultdict(lambda:{'screens':set(),'count':0,'samples':set()})
for k,v in A.items():
    if not k.startswith('dark-') : continue
    for f,d in v['fonts'].items():
        fam[f]['screens'].add(k); fam[f]['count']+=d['count']; fam[f]['samples'].update(d['samples'][:4])
P('## FONT FAMILIES (dark, all audited screens)')
for f,d in sorted(fam.items(), key=lambda x:-x[1]['count']):
    P(f"- {f}: {d['count']} text elements on {len(d['screens'])} screens; e.g. {', '.join(list(d['samples'])[:8])}")
sz=collections.defaultdict(lambda:{'screens':set(),'count':0,'samples':set()})
for k,v in A.items():
    if not k.startswith('dark-') or '1024' in k: continue
    for f,d in v['sizes'].items():
        sz[f]['screens'].add(k); sz[f]['count']+=d['count']; sz[f]['samples'].update(d['samples'][:3])
P('\n## FONT SIZES (dark 1440, all audited screens)')
for f,d in sorted(sz.items(), key=lambda x:float(x[0][:-2])):
    P(f"- {f}: {d['count']} els / {len(d['screens'])} screens; e.g. {', '.join(list(d['samples'])[:5])}")
P('\n## PER SCREEN: families | sizes')
for k,v in sorted(A.items()):
    if not k.startswith('dark-') or '1024' in k: continue
    P(f"- {k}: {', '.join(f'{f}×{d['count']}' for f,d in v['fonts'].items())} | {', '.join(sorted(v['sizes'], key=lambda x:float(x[:-2])))}")
P('\n## DOC SCROLL / UNREACHABLE / CLIPPED')
for k,v in sorted(A.items()):
    d=v['doc']
    line=[]
    if d['scrollH']>d['clientH']+2 or d['scrollW']>d['clientW']+2: line.append(f"document overflows: client {d['clientW']}x{d['clientH']} scroll {d['scrollW']}x{d['scrollH']} (body overflow {d['bodyOverflow']}, html {d['htmlOverflow']})")
    if v['unreachable']: line.append('UNREACHABLE: '+'; '.join(f"{u['el'].split(' > ')[-1]} \"{u['text'][:30]}\" @({u['left']},{u['top']})" for u in v['unreachable'][:6]))
    cl=[c for c in v['clipped']]
    if cl: line.append('CLIPPED: '+'; '.join(f"{c['el'].split(' > ')[-1]} {c['axis']} client{c['client']} scroll{c['scroll']}" for c in cl[:8]))
    if line: P(f"- {k}: "+' || '.join(line))
P('\n## TRUNCATED WITHOUT title/tooltip')
agg=collections.defaultdict(lambda:{'screens':set(),'texts':set(),'n':0})
for k,v in A.items():
    for t in v['truncated']:
        if t['escape']: continue
        key=(t['el'].split(' > ')[-1], t['kind'], t['inside'])
        agg[key]['screens'].add(k); agg[key]['texts'].add(t['text'][:60]); agg[key]['n']+=1
for key,d in sorted(agg.items(), key=lambda x:-x[1]['n']):
    P(f"- {key[0]} ({key[1]}, inside {key[2]}): {d['n']}× on {len(d['screens'])} screens e.g. {sorted(d['screens'])[0]}; texts: {list(d['texts'])[:3]}")
P('\n## TRUNCATED WITH escape (title/tooltip)')
agg2=collections.Counter()
for k,v in A.items():
    for t in v['truncated']:
        if t['escape']: agg2[(t['el'].split(' > ')[-1], t['escape'])]+=1
for key,n in agg2.most_common(15): P(f"- {key}: {n}")
P('\n## SMALL HIT AREAS (<24px)')
agg=collections.defaultdict(lambda:{'screens':set(),'dims':set(),'texts':set(),'n':0})
for k,v in A.items():
    for t in v['small']:
        key=t['el'].split(' > ')[-1]
        agg[key]['screens'].add(k); agg[key]['dims'].add((t['w'],t['h'])); agg[key]['texts'].add(t['text'][:25]); agg[key]['n']+=1
for key,d in sorted(agg.items(), key=lambda x:-x[1]['n'])[:45]:
    P(f"- {key}: {d['n']}× / {len(d['screens'])} screens, sizes {sorted(d['dims'])[:4]}, e.g. {sorted(d['screens'])[0]}; {list(d['texts'])[:3]}")
P('\n## CONTRAST FAILURES')
for theme in ('dark','light'):
    agg=collections.defaultdict(lambda:{'screens':set(),'n':0,'off':0,'samples':set(),'ratio':0,'need':0,'sizes':set()})
    for k,v in A.items():
        if not k.startswith(theme+'-'): continue
        for pair,d in v['contrast'].items():
            a=agg[pair]; a['screens'].add(k); a['n']+=d['count']; a['off']+=d.get('disabled',0); a['samples'].update(d['samples'][:2]); a['ratio']=d['ratio']; a['need']=d['need']; a['sizes'].update(d['sizes'])
    P(f'### {theme}')
    for pair,d in sorted(agg.items(), key=lambda x:-x[1]['n'])[:22]:
        off=' — ALL on disabled controls (exempt)' if d['off']>=d['n'] else (f" — {d['off']} of them on disabled controls" if d['off'] else '')
        P(f"- {pair}: {d['ratio']}:1 (need {d['need']}) — {d['n']} els / {len(d['screens'])} screens{off}; sizes {sorted(d['sizes'])}; e.g. {list(d['samples'])[:3]}; first {sorted(d['screens'])[0]}")
P('\n## FOCUS: stops without outline/box-shadow')
agg=collections.defaultdict(lambda:{'screens':set(),'n':0,'texts':set(),'styles':set()})
for k,v in A.items():
    f=v.get('focus')
    if not f: continue
    for u in f['unringed']:
        a=agg[u['el']]; a['screens'].add(k); a['n']+=1; a['texts'].add(u['text'][:25]); a['styles'].add(u['outline'])
    if f['offscreen']: P(f"- {k}: focus moved to OFFSCREEN elements: {f['offscreen'][:4]}")
for key,d in sorted(agg.items(), key=lambda x:-x[1]['n']):
    P(f"- {key}: {d['n']}× / {len(d['screens'])} screens e.g. {sorted(d['screens'])[0]}; {list(d['texts'])[:4]}; computed outline {list(d['styles'])[:2]}")
P('\n## FOCUS STOP COUNTS'); 
for k,v in sorted(A.items()):
    if v.get('focus'): P(f"- {k}: {v['focus']['stops']} stops in 40 tabs, {len(v['focus']['unringed'])} unringed")

# ---- the gate -------------------------------------------------------------------------------
SIZES={'12px','13px','14px','16px','20px','28px'}
FAMILIES={'DM Sans','DM Mono'}
def tally(pred):
    """(count, screens it was seen on)"""
    n=0; where=[]
    for k,v in sorted(A.items()):
        c=pred(v)
        if c: n+=c; where.append(k)
    return n,where
try: step_failures=json.load(open('shots/failures.json'))
except Exception: step_failures=[]
doc_over=lambda v: 1 if (v['doc']['scrollH']>v['doc']['clientH']+2 or v['doc']['scrollW']>v['doc']['clientW']+2) else 0
checks=[
 ('font sizes outside 12/13/14/16/20/28', tally(lambda v: sum(d['count'] for s,d in v['sizes'].items() if s not in SIZES))),
 ('families outside DM Sans / DM Mono', tally(lambda v: sum(d['count'] for f,d in v['fonts'].items() if f not in FAMILIES))),
 ('raw truncation (ellipsis with no way to read it)', tally(lambda v: sum(1 for t in v['truncated'] if not t['escape']))),
 ('targets under 24px', tally(lambda v: len(v['small']))),
 ('focus stops with no ring', tally(lambda v: len(v['focus']['unringed']) if v.get('focus') else 0)),
 ('clipped or unreachable content, or a scrolling document', tally(lambda v: len(v['clipped'])+len(v['unreachable'])+doc_over(v))),
 ('contrast failures on live (non-disabled) text', tally(lambda v: sum(max(0,d['count']-d.get('disabled',0)) for d in v['contrast'].values()))),
 ('capture steps that failed', (len(step_failures), step_failures[:6])),
]
ok=all(n==0 for _,(n,_) in checks)
gate=['','## STANDARDS: '+('PASS' if ok else 'FAIL'),f'({len(A)} audited screens)']
for name,(n,where) in checks:
    gate.append(f"- {'ok  ' if n==0 else 'FAIL'} {n:>5}  {name}"+('' if n==0 else '  — e.g. '+', '.join(str(w)[:90] for w in where[:3])))
out.extend(gate)
open('shots/audit-summary.md','w').write('\n'.join(out)+'\n')
print(len(out),'lines → shots/audit-summary.md')
print('\n'.join(gate))
sys.exit(0 if ok else 1)
