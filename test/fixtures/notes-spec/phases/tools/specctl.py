#!/usr/bin/env python3
"""Fixed SEV3 toolkit CLI. No application execution, network, LLM, or mutation of sources."""
import argparse
import json
import sys
from pathlib import Path
import sev3lib as s

def main():
    a=argparse.ArgumentParser(description=__doc__)
    a.add_argument("command",choices=["validate","seal","fingerprint","graph","explain","analyze","impact"])
    a.add_argument("--root",default=".")
    a.add_argument("--phase")
    a.add_argument("--role",default="planner",choices=list(s.ROLES.values()))
    a.add_argument("--document")
    a.add_argument("--init-todo",action="store_true")
    args=a.parse_args(); root=Path(args.root).resolve()
    if args.command=="fingerprint": out={"source_fingerprint":s.source_fingerprint(root)}
    elif args.command=="seal": out=s.seal(root,args.init_todo)
    elif args.command=="validate": out=s.validate(root)
    else:
        s.validate(root); m=s.load(root)
        if args.command=="graph": out=s.phase_relations(m,s.lookup_phase(m,args.phase)) if args.phase else s.relation_graph(m)
        elif args.command=="analyze": out=s.analyze_context(root,m,args.phase)
        elif args.command=="explain":
            s.require(args.phase,"--phase required"); p=s.lookup_phase(m,args.phase)
            out={"phase":p['id'],"sources":s.select_sources(root,m,p,args.role)}
        else:
            s.require(args.document in s.doc_map(m),"--document must name a canonical document")
            out={"document":args.document,"affected_phases":[p['id'] for p in m['phases'] if args.document in s.selected_documents(m,p,"planner")],
                 "warning":"New semantic dependencies still require expert review; this is only the declared reverse graph."}
    print(json.dumps(out,indent=2,ensure_ascii=False))
if __name__=="__main__":
    try: main()
    except (s.ContractError,KeyError,TypeError,ValueError,OSError) as e:
        print(json.dumps({"ok":False,"error":str(e)},ensure_ascii=False),file=sys.stderr); sys.exit(2)
