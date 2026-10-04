"""SEV3 documentation contract v1.2.0. Standard library only; never runs project code."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

VERSION = "1.2.0"
SCHEMA = "sev3/1"
MANIFEST = "phases/manifest.json"
LOCK = "phases/package-lock.json"
TOOL_LOCK = "phases/tooling-lock.json"
ROLES = {"plan": "planner", "debate": "plan-debater", "implement": "implementer", "test": "tester", "review": "reviewer"}
REQUIRED_DOCS = ("phases/README.md", "phases/AGENTS.md", "phases/EXECUTION_GUIDE.md", "phases/research.md", "phases/todo.md")
PHASE_SECTIONS = ("objective", "scope", "contracts", "implementation", "verification", "acceptance", "handover")
RELATED_SECTIONS = set(PHASE_SECTIONS) - {"implementation"}
TOOL_FILES = ("sev3lib.py", "phase_context.py", "verify_package.py", "specctl.py", "VERSION")

class ContractError(ValueError):
    pass

def require(value: Any, message: str) -> None:
    if not value:
        raise ContractError(message)

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")

def safe_path(root: Path, relative: str, must_exist: bool = True) -> Path:
    require(isinstance(relative, str) and bool(relative), "Empty/non-string path")
    p = Path(relative)
    require(not p.is_absolute() and ".." not in p.parts and "\\" not in relative and ":" not in relative, f"Unsafe path: {relative}")
    base = root.resolve()
    candidate = base / p
    require(candidate.resolve().is_relative_to(base), f"Path escapes package: {relative}")
    # Symlinks are rejected even inside the package so an index cannot silently alias a secret.
    for part in (candidate, *candidate.parents):
        if part == base:
            break
        require(not part.is_symlink(), f"Symlink not allowed in package path: {relative}")
    if must_exist:
        require(candidate.is_file(), f"Missing source: {relative}")
    return candidate

def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"), parse_constant=lambda s: (_ for _ in ()).throw(ValueError(s)))
    except (OSError, ValueError) as exc:
        raise ContractError(f"Invalid JSON: {path.name}: {type(exc).__name__}") from exc

def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".sev3-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def load(root: Path) -> dict:
    m = read_json(safe_path(root, MANIFEST))
    require(isinstance(m, dict) and m.get("schema_version") == SCHEMA, "Unsupported SEV3 manifest schema")
    require(m.get("toolkit_version") == VERSION, "Unsupported toolkit version; do not rewrite project helpers")
    return m

def phase_id(value: str | int) -> str:
    text = str(value).upper().removeprefix("P-")
    require(text.isdigit() and int(text) > 0, "Invalid phase ID")
    return f"P-{int(text):03d}"

def lookup_phase(m: dict, value: str | int) -> dict:
    pid = phase_id(value)
    for p in m["phases"]:
        if p["id"] == pid:
            return p
    raise ContractError(f"Unknown phase: {pid}")

def doc_map(m: dict) -> dict:
    return {d["id"]: d for d in m["documents"]}

def registry(m: dict) -> dict:
    return {"schema_version": SCHEMA, "requirements": {
        rid: {"document": d["id"], "en": d["en"], "ar": d["ar"],
              "phases": [p["id"] for p in m["phases"] if rid in p["requirements"]]}
        for d in m["documents"] for rid in d["ids"]}}

def todo_text(m: dict) -> str:
    lines = ["# Implementation TODO", "", "One shared execution tracker. Check items only after verified evidence; the phase checkbox requires independent gates and a handover.", ""]
    for p in m["phases"]:
        lines += [f'- [ ] {p["id"]} - {p["title"]}', f'  - [ ] {p["id"]}:implementation']
        lines += [f'  - [ ] {p["id"]}:gate:{g["id"]}' for g in p["gates"]]
        lines += [f'  - [ ] {p["id"]}:independent-test', f'  - [ ] {p["id"]}:independent-review', f'  - [ ] {p["id"]}:handover', ""]
    lines += ["- [ ] PROJECT:production-readiness", ""]
    return "\n".join(lines)

def check_graph(dm: dict) -> None:
    visiting, done = set(), set()
    def visit(key: str) -> None:
        require(key in dm, f"Unknown document dependency: {key}")
        require(key not in visiting, f"Document dependency cycle at {key}")
        if key in done:
            return
        visiting.add(key)
        for dep in dm[key].get("depends_on", []):
            visit(dep)
        visiting.remove(key)
        done.add(key)
    for key in dm:
        visit(key)

def validate(root: Path, locked: bool = True) -> dict:
    m = load(root)
    require(isinstance(m.get("project"), dict) and m["project"].get("id") and m["project"].get("title"), "Missing project identity")
    require(m["project"].get("canonical_language") == "en", "English must be canonical")
    validate_refinement(root, m)
    require(isinstance(m.get("documents"), list) and m["documents"], "No requirement documents")
    require(isinstance(m.get("phases"), list) and m["phases"], "No implementation phases")
    dm = doc_map(m)
    require(len(dm) == len(m["documents"]), "Duplicate document IDs")
    seen_ids, seen_paths = set(), set()
    for d in m["documents"]:
        require(isinstance(d.get("id"), str) and re.fullmatch(r"[A-Z][A-Z0-9_.-]{1,100}", d["id"]), "Invalid document identity")
        require(d.get("kind") in ("global", "requirement", "contract"), f'Unknown document kind: {d["id"]}')
        require(isinstance(d.get("ids"), list) and d["ids"], f'No requirement IDs: {d["id"]}')
        require(len(d["ids"]) == len(set(d["ids"])), "Duplicate requirement ID within document")
        require(not (set(d["ids"]) & seen_ids), "Requirement ID owned by multiple documents")
        seen_ids.update(d["ids"])
        for language in ("en", "ar"):
            rel = d.get(language, "")
            require(rel.startswith(f"requirements/{language}/") and rel.endswith(".md"), f"Invalid requirement location: {rel}")
            require(rel not in seen_paths, f"Duplicate canonical path: {rel}")
            seen_paths.add(rel)
            text = safe_path(root, rel).read_text(encoding="utf-8")
            markers = re.findall(r"<!--\s*req:\s*([^\s>]+)\s*-->", text)
            require(sorted(markers) == sorted(d["ids"]), f"Requirement marker mismatch in {rel}")
            require("__AUTHOR_REQUIRED__" not in text, f"Unfinished source: {rel}")
    for d in m["documents"]:
        if "always_read" in d:
            require(d["kind"] == "global" and isinstance(d["always_read"], bool), "always_read is a global-only boolean")
    check_graph(dm)
    pids = [p["id"] for p in m["phases"]]
    require(len(pids) == len(set(pids)), "Duplicate phase IDs")
    coverage, owners = set(), []
    for i, p in enumerate(m["phases"], 1):
        require(p.get("number") == i and p["id"] == phase_id(i), "Phases must be contiguous and sequential")
        require(p.get("title") and p.get("risk") in ("low", "medium", "high", "critical"), f'Missing/invalid phase risk: {p["id"]}')
        require(p.get("work_class") in ("small", "medium", "large"), f'Missing expert-authored work class: {p["id"]}')
        require(p.get("kind") in ("implementation", "closure", "documentation"), "Invalid phase kind")
        require(isinstance(p.get("sections"), list) and sorted(p["sections"]) == sorted(PHASE_SECTIONS), "Each phase declares exactly the seven canonical sections")
        for dep in p.get("requires", []):
            require(dep in pids[:i-1], f'Forward/missing phase prerequisite: {p["id"]} -> {dep}')
        require(isinstance(p.get("owns"), list), "Missing phase ownership")
        for key in p["owns"]:
            require(key in dm and dm[key]["kind"] in ("requirement", "contract"), f"Invalid owned document: {key}")
            owners.append(key)
        for entry in p.get("uses", []):
            require(entry.get("document") in dm and entry.get("reason") and entry.get("direction") in ("upstream", "consumer", "shared"), "Contract use needs exact document, direction and reason")
        require(isinstance(p.get("requirements"), list) and p["requirements"], "Phase must map requirements")
        required = set(p["requirements"])
        require(required <= seen_ids, f'Unknown requirement in {p["id"]}')
        owned_ids = {rid for key in p["owns"] for rid in dm[key]["ids"]}
        require(owned_ids <= required, f'Owned requirement not mapped in {p["id"]}')
        require(isinstance(p.get("gates"), list) and p["gates"], f'No gates: {p["id"]}')
        gates, gate_coverage = set(), set()
        for g in p["gates"]:
            require(g.get("id") and g["id"] not in gates, "Missing/duplicate gate ID")
            gates.add(g["id"])
            require(g.get("kind") in ("test", "static", "build", "security", "manual", "integration"), "Invalid gate kind")
            require(isinstance(g.get("requirements"), list) and g["requirements"], "Gate must map requirements")
            require(set(g["requirements"]) <= required, "Gate maps out-of-phase requirement")
            gate_coverage.update(g["requirements"])
            require(isinstance(g.get("negative"), bool), "Gate must declare negative true/false")
            require(isinstance(g.get("command"), list) and g["command"] and all(isinstance(x,str) and x for x in g["command"]), "Gate command must be an argv array (manual gates use documented inspection command)")
            require(g["command"][0] not in ("true", "echo"), "No-op gate forbidden")
            require(not any("test-lowmem" in x for x in g["command"]), "Memory-gate shortcut prohibited in this toolkit profile")
            evidence = g.get("evidence", {})
            require(isinstance(evidence, dict) and evidence.get("format") in ("unittest", "junit", "none"), "Declare a supported gate evidence format")
            if g["kind"] in ("test", "integration") or g["negative"]:
                require(evidence["format"] != "none", "Tests/negative gates require nonempty count evidence")
            if evidence["format"] == "junit":
                rel = evidence.get("path", "")
                require(rel.startswith(".looprch/test-evidence/") and rel.endswith(".xml"), "JUnit reports need a dedicated .looprch/test-evidence/*.xml path")
                safe_path(root, rel, False)
            require(type(g.get("timeout_seconds", 300)) is int and 1 <= g.get("timeout_seconds", 300) <= 86400, "Invalid gate timeout")

        require(required <= gate_coverage, f'Requirements without acceptance evidence: {p["id"]}')
        if p["risk"] in ("high", "critical"):
            require(any(g["negative"] for g in p["gates"]), f'High-risk phase needs explicit negative evidence: {p["id"]}')
        coverage.update(required)
        for language in ("en", "ar"):
            rel = p.get(language, "")
            require(rel.startswith(f"phases/{language}/") and rel.endswith(".md"), "Invalid phase path")
            require(rel not in seen_paths, "Duplicate phase source")
            seen_paths.add(rel)
            text = safe_path(root, rel).read_text(encoding="utf-8")
            require(f'<!-- phase: {p["id"]} -->' in text, f"Missing phase marker: {rel}")
            require("__AUTHOR_REQUIRED__" not in text, f"Unfinished phase: {rel}")
            validate_sections(root, p, language)
            for rid in p["requirements"]:
                require(rid in text, f"Phase text omits mapped requirement {rid}: {rel}")
    validate_relations(m)
    require(len(owners) == len(set(owners)), "Requirement capability has multiple implementation owners")
    require(set(owners) == {d["id"] for d in m["documents"] if d["kind"] in ("requirement", "contract")}, "Unowned requirement capability")
    require(coverage == seen_ids, "Project contains unscheduled requirements")
    require(m["phases"][-1]["kind"] == "closure", "Final phase must close full production readiness")
    require(set(m["phases"][-1]["requirements"]) == seen_ids, "Final closure must explicitly map every project requirement")
    for folder in ("requirements/en", "requirements/ar", "phases/en", "phases/ar"):
        actual = {str(p.relative_to(root)).replace(os.sep,"/") for p in (root/folder).rglob("*.md") if p.name != "INDEX.md"}
        require(actual <= seen_paths, f"Unindexed canonical documents in {folder}: {sorted(actual-seen_paths)}")
    for rel in REQUIRED_DOCS:
        text = safe_path(root, rel).read_text(encoding="utf-8")
        require(text.strip() and "__AUTHOR_REQUIRED__" not in text, f"Unfinished required document: {rel}")
    actual_todo = safe_path(root, "phases/todo.md").read_text(encoding="utf-8")
    expected_keys = re.findall(r"^- \[ \] (P-\d+) -", todo_text(m), re.M)
    actual_keys = re.findall(r"^- \[[ x]\] (P-\d+) -", actual_todo, re.M)
    require(actual_keys == expected_keys, "TODO phase order/count mismatch")
    for line in todo_text(m).splitlines():
        if line.startswith("  - [ ]") or "PROJECT:production-readiness" in line:
            require(line.replace("[ ]", "[x]") in actual_todo or line in actual_todo, f"Missing TODO gate: {line}")
    for p in m["phases"]:
        for research_id in p.get("research", []):
            research_section(root, research_id)
    if locked:
        verify_lock(root, m)
    return {"schema_version": SCHEMA, "ok": True, "phase_count": len(pids), "requirement_count": len(seen_ids), "toolkit_version": VERSION,
            "semantic_translation_verified": False, "application_verified": False}

def research_section(root: Path, research_id: str) -> tuple[bytes,int,int]:
    require(re.fullmatch(r"RES-[0-9]+", research_id) is not None, "Invalid research ID")
    lines = safe_path(root, "phases/research.md").read_bytes().splitlines(keepends=True)
    starts = [i for i,line in enumerate(lines) if line.decode("utf-8").strip() == f"<!-- research: {research_id} -->"]
    ends = [i for i,line in enumerate(lines) if line.decode("utf-8").strip() == f"<!-- /research: {research_id} -->"]
    require(len(starts)==1 and len(ends)==1 and starts[0] < ends[0], f"Missing/ambiguous research section: {research_id}")
    a,b = starts[0],ends[0]+1
    return b"".join(lines[a:b]),a+1,b

def canonical_paths(m: dict) -> list[str]:
    paths = {MANIFEST, "requirements/registry.json", TOOL_LOCK,
             "requirements/en/INDEX.md", "requirements/ar/INDEX.md", "phases/en/INDEX.md", "phases/ar/INDEX.md",
             "phases/relations.json", "phases/RELATIONSHIPS.md"}
    paths.update(x for x in REQUIRED_DOCS if x != "phases/todo.md")
    paths.update(d[l] for d in m["documents"] for l in ("en","ar"))
    paths.update(p[l] for p in m["phases"] for l in ("en","ar"))
    paths.add("phases/refinement.json")
    paths.update(f"phases/context/en/{p['id']}.md" for p in m["phases"])
    paths.update(f"phases/tools/{name}" for name in TOOL_FILES)
    return sorted(paths)

def seal(root: Path, initialize_todo: bool = False) -> dict:
    m = load(root)
    if initialize_todo:
        p = safe_path(root, "phases/todo.md", False)
        require(not p.exists(), "Refuse to overwrite persistent TODO")
        atomic_write(p, todo_text(m).encode("utf-8"))
    # These are mechanical derived views, never independent specifications.
    atomic_write(safe_path(root,"requirements/registry.json",False),json_bytes(registry(m)))
    for language in ("en","ar"):
        for folder,key,entries in (("requirements","documents",m["documents"]),("phases","phases",m["phases"])):
            index = [f"# {folder} index ({language})", "", "Navigation only. Read the actual canonical source bodies.", ""]
            index += [f'- [{e["id"]}]({Path(e[language]).relative_to(Path(folder)/language).as_posix()})' for e in entries]
            atomic_write(safe_path(root,f"{folder}/{language}/INDEX.md",False),("\n".join(index)+"\n").encode("utf-8"))
    atomic_write(safe_path(root,"phases/relations.json",False),json_bytes(relation_graph(m)))
    atomic_write(safe_path(root,"phases/RELATIONSHIPS.md",False),relationship_markdown(m).encode("utf-8"))
    tools = {name:sha(safe_path(root,f"phases/tools/{name}").read_bytes()) for name in TOOL_FILES}
    atomic_write(safe_path(root,TOOL_LOCK,False),json_bytes({"version":VERSION,"sha256":tools}))
    validate(root,locked=False)
    for phase in m["phases"]:
        atomic_write(safe_path(root,f"phases/context/en/{phase['id']}.md",False),render_context(root,m,phase).encode("utf-8"))
    files={rel:sha(safe_path(root,rel).read_bytes()) for rel in canonical_paths(m)}
    locked={"schema_version":SCHEMA,"sha256":files,"fingerprint":sha(json_bytes(files))}
    atomic_write(safe_path(root,LOCK,False),json_bytes(locked))
    return {"ok":True,"fingerprint":locked["fingerprint"],"file_count":len(files)}

def verify_lock(root: Path,m:dict|None=None) -> str:
    m=m or load(root)
    data=read_json(safe_path(root,LOCK))
    require(data.get("schema_version")==SCHEMA,"Invalid package lock schema")
    expected={rel:sha(safe_path(root,rel).read_bytes()) for rel in canonical_paths(m)}
    require(data.get("sha256")==expected,"Package changed since seal; expert-authored update and re-validation required")
    require(data.get("fingerprint")==sha(json_bytes(expected)),"Invalid package fingerprint")
    require(read_json(safe_path(root,"requirements/registry.json"))==registry(m),"Registry drift")
    require(read_json(safe_path(root,"phases/relations.json"))==relation_graph(m),"Relationship graph drift")
    tools=read_json(safe_path(root,TOOL_LOCK))
    require(tools.get("version")==VERSION and tools.get("sha256")=={n:sha(safe_path(root,f"phases/tools/{n}").read_bytes()) for n in TOOL_FILES},"Tooling drift")
    return data["fingerprint"]

def phase_section(root: Path, phase: dict, section: str, language: str = "en") -> tuple[bytes, int, int]:
    require(section in PHASE_SECTIONS, f"Unknown phase section: {section}")
    lines = safe_path(root, phase[language]).read_bytes().splitlines(keepends=True)
    marker = f'{phase["id"]}.{section}'
    starts = [i for i, line in enumerate(lines) if line.decode("utf-8").strip() == f"<!-- section: {marker} -->"]
    ends = [i for i, line in enumerate(lines) if line.decode("utf-8").strip() == f"<!-- /section: {marker} -->"]
    require(len(starts) == 1 and len(ends) == 1 and starts[0] < ends[0], f"Missing/ambiguous phase section: {marker}/{language}")
    a, b = starts[0], ends[0] + 1
    return b"".join(lines[a:b]), a + 1, b


def validate_sections(root: Path, phase: dict, language: str) -> None:
    text = safe_path(root, phase[language]).read_text(encoding="utf-8")
    expected = [f'{phase["id"]}.{x}' for x in PHASE_SECTIONS]
    starts = re.findall(r"<!--\s*section:\s*([^\s>]+)\s*-->", text)
    ends = re.findall(r"<!--\s*/section:\s*([^\s>]+)\s*-->", text)
    require(starts == expected and ends == expected, f"Phase sections must be complete, ordered and unique: {phase['id']}/{language}")
    ranges = []
    for section in PHASE_SECTIONS:
        body, a, b = phase_section(root, phase, section, language)
        require(b - a > 2, f"Empty phase section: {phase['id']}.{section}")
        require(f'id="{phase["id"].lower()}-{section}"' in body.decode("utf-8"), f"Missing stable link anchor: {phase['id']}.{section}")
        ranges.append((a, b))
    require(all(ranges[i][1] < ranges[i + 1][0] for i in range(len(ranges)-1)), "Overlapping/nested phase sections are forbidden")


def phase_documents(m: dict, phase: dict) -> set[str]:
    mapped = {rid: d['id'] for d in m['documents'] for rid in d['ids']}
    return set(phase.get('owns', [])) | {u['document'] for u in phase.get('uses', [])} | {mapped[rid] for rid in phase['requirements']}


def validate_relations(m: dict) -> None:
    dm = doc_map(m)
    by_phase = {p['id']: p for p in m['phases']}
    owner = {key:p for p in m['phases'] for key in p.get('owns',[])}
    for phase in m['phases']:
        for use in phase.get('uses',[]):
            producer=owner.get(use['document'])
            if producer is None:
                require(dm[use['document']]['kind']=='global','Referenced contract has no owner')
                continue
            if use['direction']=='upstream':
                require(producer['number']<phase['number'] and producer['id'] in phase.get('requires',[]),'Upstream contract use requires an earlier closed producer')
            if use['direction']=='consumer':
                require(producer['number']>phase['number'],'Consumer reference must point forward without executing future scope')
        seen = set()
        for link in phase.get('related', []):
            require(isinstance(link, dict), "Related phase edge must be an object")
            target_id = link.get('phase')
            require(target_id in by_phase and target_id != phase['id'], "Unknown/self related phase")
            target = by_phase[target_id]
            relation = link.get('relation')
            require(relation in ('upstream', 'consumer', 'shared', 'impact'), "Unknown phase relationship type")
            require((target_id, relation) not in seen, "Duplicate phase relation; combine exact references")
            seen.add((target_id, relation))
            require(isinstance(link.get('reason'), str) and link['reason'].strip(), "Phase relationship requires a concrete reason")
            documents, sections = link.get('documents', []), link.get('sections', [])
            require(isinstance(documents, list) and len(documents) == len(set(documents)) and set(documents) <= set(dm), "Unknown/duplicate linked document")
            require(isinstance(sections, list) and len(sections) == len(set(sections)) and set(sections) <= RELATED_SECTIONS, "Related reads must name permitted complete sections; never wildcard or implementation")
            require(set(documents) <= phase_documents(m, target), "Linked document not associated with the referenced phase")
            roles = link.get('roles', list(ROLES.values()))
            require(isinstance(roles, list) and roles and len(roles) == len(set(roles)) and set(roles) <= set(ROLES.values()), "Invalid relationship roles")
            if relation == 'impact':
                require(not documents and not sections, "Impact-only edges are navigation, not source admission")
            else:
                require(documents or sections, "Relationship must identify an exact contract or phase section")
                require({'planner', 'plan-debater'} <= set(roles), "Planner and Debater both need declared relationship context")
            if relation == 'upstream':
                require(target['number'] < phase['number'] and target_id in phase.get('requires', []), "An upstream runtime prerequisite must be earlier and explicitly declared in requires")
            elif relation == 'consumer':
                require(target['number'] > phase['number'], "Consumer look-ahead must point to a later phase")
            elif relation == 'shared':
                require(set(documents) & phase_documents(m, phase), "Shared relation must name an actual shared document")
            if 'gates' in link:
                require(isinstance(link['gates'], list) and set(link['gates']) <= {g['id'] for g in phase['gates']}, "Related seam has unknown current-phase gate")


def phase_relations(m: dict, phase: dict, role: str | None = None) -> dict:
    role = ROLES.get(role, role)
    result = []
    for link in phase.get('related', []):
        target = lookup_phase(m, link['phase'])
        admitted = link['relation'] != 'impact' and (role is None or role in link.get('roles', list(ROLES.values())))
        result.append({**link, 'title': target['title'], 'source': target['en'],
                       'read_admitted': admitted, 'scope': 'exact declared sources; no recursive phase preflight'})
    # These are metadata, not an invitation to crawl a neighbor's neighbors.
    incoming = [{'phase': p['id'], 'relation': link['relation'], 'reason': link['reason']}
                for p in m['phases'] for link in p.get('related', []) if link['phase'] == phase['id']]
    return {'phase': phase['id'], 'execution_prerequisites': phase.get('requires', []),
            'related': result, 'incoming_mentions': incoming,
            'notice': 'Chronological order, source reading and change impact are distinct graphs.'}


def relation_graph(m: dict) -> dict:
    return {'schema_version': SCHEMA, 'toolkit_version': VERSION,
            'phases': [phase_relations(m, p) for p in m['phases']],
            'documents': [{'id': d['id'], 'kind': d['kind'], 'depends_on': d.get('depends_on', [])}
                          for d in m['documents']]}


def relationship_markdown(m: dict) -> str:
    lines = ['# Phase relationships', '', 'Generated navigation, NOT an alternate specification. Read the exact canonical blocks admitted by the reader.', '']
    dm = doc_map(m)
    for p in m['phases']:
        lines += [f'## {p["id"]} - {p["title"]}', '', f'Current phase: [{p["id"]}]({Path(p["en"]).relative_to("phases").as_posix()})',
                  'Execution prerequisites: ' + (', '.join(p.get('requires', [])) or 'none') + '. Order alone adds no read.', '']
        for link in p.get('related', []):
            target = lookup_phase(m, link['phase'])
            refs = [f'[{x}](../{dm[x]["en"]})' for x in link.get('documents', [])]
            refs += [f'[{target["id"]}.{x}]({Path(target["en"]).relative_to("phases").as_posix()}#{target["id"].lower()}-{x})' for x in link.get('sections', [])]
            lines += [f'- {link["relation"]} {link["phase"]}: {link["reason"]} | ' + ('; '.join(refs) or 'metadata only')]
        if not p.get('related'): lines += ['No declared phase-plan excerpt reads. Owned and required contracts are still mandatory.']
        lines += ['']
    return '\n'.join(lines)


def selected_documents(m: dict, phase: dict, role: str, extra_docs: list[str] | None = None, reason: str | None = None) -> dict[str, list[str]]:
    dm = doc_map(m)
    selected: dict[str, list[str]] = {}
    def include(key: str, why: str) -> None:
        require(key in dm, f"Unknown required document: {key}")
        if key in selected:
            if why not in selected[key]: selected[key].append(why)
            return
        selected[key] = [why]
        # Only explicit complete-source interpretive prerequisites recurse, never phase links.
        for dep in dm[key].get('depends_on', []): include(dep, f'Normative prerequisite {key} -> {dep}')
    for d in m['documents']:
        if d['kind'] == 'global' and d.get('always_read', True): include(d['id'], 'Universal invariant')
    for key in phase['owns']: include(key, f'Owned by {phase["id"]}')
    mapped = {rid: d['id'] for d in m['documents'] for rid in d['ids']}
    for rid in phase['requirements']: include(mapped[rid], f'Current acceptance maps {rid}')
    for entry in phase.get('uses', []): include(entry['document'], f'{entry["direction"]}: {entry["reason"]}')
    for link in phase.get('related', []):
        if link['relation'] != 'impact' and role in link.get('roles', list(ROLES.values())):
            for key in link.get('documents', []): include(key, f'{phase["id"]} {link["relation"]} {link["phase"]}: {link["reason"]}')
    if phase['kind'] == 'closure':
        for key in dm: include(key, 'Whole-product final closure')
    if extra_docs:
        require(bool(reason and reason.strip()), 'Extra requirement reads need target-related evidence/reason')
        for key in extra_docs: include(key, f'Explicit source expansion: {reason}')
    return selected


def select_sources(root: Path, m: dict, phase: dict, role: str, extra_docs: list[str] | None = None,
                   extra_phases: list[str] | None = None, reason: str | None = None,
                   authorization: dict | None = None) -> list[dict]:
    role = ROLES.get(role, role)
    require(role in ROLES.values(), 'Only worker roles may request source packets')
    selected = selected_documents(m, phase, role, extra_docs, reason)
    sources = []
    def source(path: str, why: str, kind: str, block: tuple[bytes, int, int] | None = None) -> None:
        if block is None:
            data = safe_path(root, path).read_bytes()
            a, b = 1, len(data.splitlines())
        else: data, a, b = block
        sources.append({'path': path, 'kind': kind, 'reason': why, 'sha256': sha(data),
                        'bytes': len(data), 'start_line': a, 'end_line': b})
    source('phases/AGENTS.md', 'Execution contract', 'instruction')
    source('phases/EXECUTION_GUIDE.md', 'Reader and completion contract', 'instruction')
    source(phase['en'], 'Complete current phase', 'phase')
    for d in m['documents']:
        if d['id'] in selected: source(d['en'], '; '.join(selected[d['id']]), 'requirement')
    for rid in phase.get('research', []): source('phases/research.md', rid, 'research', research_section(root, rid))
    for link in phase.get('related', []):
        if link['relation'] == 'impact' or role not in link.get('roles', list(ROLES.values())): continue
        target = lookup_phase(m, link['phase'])
        for section in link.get('sections', []):
            source(target['en'], f'Declared {link["relation"]} {target["id"]}.{section}: {link["reason"]}',
                   'related-phase-section', phase_section(root, target, section))
    for value in extra_phases or []:
        pid = phase_id(value)
        require(authorization and authorization.get('target') == phase['id'] and pid in authorization.get('phase_ids', [])
                and authorization.get('question') and authorization.get('reference') and reason,
                'Additional phase read requires a specific documented gap, source and reason')
        require(role in ('planner','plan-debater','tester','reviewer'), 'Implementer requests missing cross-phase context through Planner')
        if pid != phase['id']: source(lookup_phase(m, pid)['en'], f'Documented expert gap: {authorization["reference"]}', 'authorized-phase')
    unique = {(s['path'], s['start_line'], s['end_line']): s for s in sources}
    # A full explicit read subsumes excerpts; do not duplicate overlapping source bytes.
    return [s for key, s in unique.items() if not any(t['path'] == s['path'] and
            t['start_line'] <= s['start_line'] and t['end_line'] >= s['end_line'] and other != key
            for other, t in unique.items())]


def source_bytes(root: Path, s: dict) -> bytes:
    lines = safe_path(root, s['path']).read_bytes().splitlines(keepends=True)
    a, b = s['start_line'], s['end_line']
    require(type(a) is int and type(b) is int and 1 <= a <= b <= len(lines), 'Invalid source range')
    data = b''.join(lines[a-1:b])
    require(sha(data) == s['sha256'], 'Source changed while packet was being built')
    return data


def analyze_context(root: Path, m: dict, target: str | None = None) -> dict:
    phases = [lookup_phase(m, target)] if target else m['phases']
    analyses = []
    for p in phases:
        sources = select_sources(root, m, p, 'planner')
        selected = selected_documents(m, p, 'planner')
        direct = phase_documents(m, p) | {x['document'] for x in p.get('uses', [])}
        inherited = [key for key, reasons in selected.items() if key not in direct and all(r.startswith('Normative prerequisite') for r in reasons)]
        warnings = []
        if len(inherited) > max(5, len(direct) * 2): warnings.append('High inherited source fan-in: expert should inspect whether narrow published contract units can replace broad capability dependencies; never trim required text automatically.')
        if len(p.get('related', [])) > 12: warnings.append('High relation fan-out: check for broad domain/chronology links without a concrete decision need.')
        if p['kind'] == 'closure': warnings.append('Full-source final closure is intentional; inspect in batches without omitting requirements.')
        analyses.append({'phase': p['id'], 'risk': p['risk'], 'work_class': p['work_class'],
          'owned_units': p['owns'], 'requirement_documents': len(selected), 'inherited_only_documents': inherited,
          'required_bytes': sum(s['bytes'] for s in sources), 'related_section_bytes': sum(s['bytes'] for s in sources if s['kind'] == 'related-phase-section'),
          'related_section_count': sum(s['kind'] == 'related-phase-section' for s in sources),
          'full_phase_plan_count': sum(s['kind'] in ('phase', 'authorized-phase') for s in sources),
          'warnings': warnings})
    return {'schema_version': SCHEMA, 'phases': analyses,
            'notice': 'Byte counts describe exact required input, not tokens, quotas or measured model quality. Advisories never authorize truncation or weaken gates.'}


REFINEMENT_CHECKS = ("ownership", "contracts", "lifecycle", "security", "failure_paths", "dependencies", "scope_boundaries", "verification", "translation", "context_completeness")

def source_fingerprint(root: Path, m: dict | None = None) -> str:
    """Source identity, not semantic proof. Generated views and mutable TODO are excluded."""
    m = m or load(root)
    paths = {MANIFEST, "phases/research.md", "phases/AGENTS.md", "phases/EXECUTION_GUIDE.md", "phases/README.md"}
    paths.update(d[l] for d in m["documents"] for l in ("en", "ar"))
    paths.update(p[l] for p in m["phases"] for l in ("en", "ar"))
    return sha(json_bytes({x:sha(safe_path(root,x).read_bytes()) for x in sorted(paths)}))

def validate_refinement(root: Path, m: dict) -> None:
    review = read_json(safe_path(root, "phases/refinement.json"))
    require(review.get("schema_version") == "sev3-refinement/1", "Missing final cross-phase refinement attestation")
    require(review.get("source_fingerprint") == source_fingerprint(root,m), "Refinement is stale: review changed source meaning before resealing")
    require(isinstance(review.get("reviewer"), str) and len(review["reviewer"].strip()) >= 3, "Missing refinement author")
    require(review.get("unresolved_blockers") == [], "Unresolved specification blockers")
    phases = review.get("phases", {})
    require(set(phases) == {p["id"] for p in m["phases"]}, "Refinement must cover every phase, not a sample")
    for phase in m["phases"]:
        r = phases[phase["id"]]
        require(set(r.get("checks", {})) == set(REFINEMENT_CHECKS) and all(v == "reviewed" for v in r["checks"].values()), "Incomplete semantic refinement record")
        require(isinstance(r.get("notes"), str) and len(r["notes"].strip()) >= 12, "Record concrete phase boundary/coverage observations")
    require(review.get("claim") == "author-attestation-not-machine-proof", "Do not represent semantic attestation as automated proof")

def render_context(root: Path, m: dict, phase: dict) -> str:
    """A read-only materialized view: never summarize normative source text."""
    sources = select_sources(root,m,phase,"planner")
    owns = set(phase.get("owns",[]))
    dm = doc_map(m)
    by_path = {d["en"]:d for d in m["documents"]}
    owners = {key:p["id"] for p in m["phases"] for key in p.get("owns",[])}
    groups: dict[str,list[dict]] = {}
    for src in sources:
        doc = by_path.get(src["path"])
        if doc and doc["id"] not in owns:
            group = owners.get(doc["id"],"GLOBAL")
        elif src["kind"] == "related-phase-section":
            group = next(p["id"] for p in m["phases"] if p["en"] == src["path"])
        else: continue
        groups.setdefault(group,[]).append(src)
    lines = [f"# {phase['id']} cross-phase context", "", "GENERATED / READ-ONLY. Mandatory reference for compatibility; NOT additional execution scope.",
             "Only tasks explicitly owned by the current phase may be executed. Source constraints remain binding.",
             "Specified contracts are NOT proof of implemented prerequisites. Inspect actual closed handovers and code.",
             f"Source fingerprint: `{source_fingerprint(root,m)}`", ""]
    for group, entries in groups.items():
        lines += [f"## Context from {group}", ""]
        for src in entries:
            lines += [f"### {src['path']}:{src['start_line']}-{src['end_line']}",f"Why: {src['reason']}",f"SHA256: `{src['sha256']}`", "", source_bytes(root,src).decode("utf-8"), ""]
    if not groups: lines += ["No external contract bodies are required for this phase.", ""]
    return "\n".join(lines)

def packet(root: Path, target: str, role: str, extra_docs=None, extra_phases=None, reason=None, question=None) -> dict:
    m=load(root); validate(root); phase=lookup_phase(m,target)
    grant={"target":phase['id'],"phase_ids":[phase_id(x) for x in extra_phases or []],"question":question,"reference":reason}
    sources=select_sources(root,m,phase,role,extra_docs,extra_phases,reason,grant)
    text=[f"# {phase['id']} / {ROLES.get(role,role)} exact-source packet", "",
          "Read all supplied canonical bodies. Other-phase context is binding reference, NOT extra implementation scope.",
          "No summary replaces an original requirement. Do not recursively follow another phase's reading recipe.",
          "Inspect real repository contracts and CLOSED predecessor evidence before claiming reuse.",""]
    for src in sources:
        text += [f"## SOURCE {src['path']}:{src['start_line']}-{src['end_line']}", f"Reason: {src['reason']}",
                 source_bytes(root,src).decode('utf-8'), ""]
    return {"schema_version":"sev3-packet/1","phase":phase['id'],"role":ROLES.get(role,role),
            "package_fingerprint":verify_lock(root,m),"sources":sources,"markdown":"\n".join(text),
            "gap_expansion":{"documents":extra_docs or [],"phases":extra_phases or [],"reason":reason,"question":question}}
