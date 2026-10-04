#!/usr/bin/env python3
"""Build a verified exact-source packet. Use one implementation in every project."""
import argparse
import json
import sys
from pathlib import Path
import sev3lib as s

def main():
    a=argparse.ArgumentParser(description=__doc__)
    a.add_argument("--root",default="."); a.add_argument("--phase",required=True)
    a.add_argument("--role",default="planner",choices=list(s.ROLES.values()))
    a.add_argument("--include-document",action="append",default=[])
    a.add_argument("--include-phase",action="append",default=[])
    a.add_argument("--reason"); a.add_argument("--question")
    a.add_argument("--format",choices=["json","markdown"],default="markdown")
    a.add_argument("--output")
    x=a.parse_args()
    if x.include_document or x.include_phase: s.require(x.reason and x.question,"Expansion needs an explicit question and reason")
    p=s.packet(Path(x.root).resolve(),x.phase,x.role,x.include_document,x.include_phase,x.reason,x.question)
    text=json.dumps(p,indent=2,ensure_ascii=False) if x.format=="json" else p['markdown']
    if x.output:
        out=Path(x.output).resolve(); base=Path(x.root).resolve()
        s.require(out.is_relative_to(base/".looprch") or out.is_relative_to(base/".sev3-cache"),"Output must be under project .looprch/ or .sev3-cache/, never canonical sources")
        s.atomic_write(out,(text+"\n").encode())
        print(json.dumps({"ok":True,"path":str(out),"bytes":len(text.encode()),"sources":len(p['sources'])}))
    else: print(text)
if __name__=="__main__":
    try: main()
    except (s.ContractError,KeyError,TypeError,ValueError,OSError) as e:
        print(json.dumps({"ok":False,"error":str(e)}),file=sys.stderr);sys.exit(2)
