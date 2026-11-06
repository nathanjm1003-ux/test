"""Structural checks for the Quiet project, standing in for a compiler.

Checks:
 1. project.yml parses and every source path it names exists
 2. every .swift file in the tree is claimed by at least one target
 3. braces/parens/brackets balance per file (outside strings and comments)
 4. a target does not reference a top-level type declared in a Shared file
    it does not compile  -- the classic XcodeGen per-file-inclusion bug
"""
import re, sys, pathlib, collections

ROOT = pathlib.Path("/home/user/test/Quiet")
fail = []

# ---------- 1. project.yml ----------
try:
    import yaml
    spec = yaml.safe_load((ROOT / "project.yml").read_text())
except ImportError:
    import subprocess, json
    spec = json.loads(subprocess.run(
        ["ruby", "-ryaml", "-rjson", "-e",
         "puts YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Symbol]).to_json",
         str(ROOT / "project.yml")],
        capture_output=True, text=True, check=True).stdout)

targets = spec["targets"]
target_files = {}
for name, cfg in targets.items():
    files = set()
    for entry in cfg.get("sources", []):
        p = entry["path"] if isinstance(entry, dict) else entry
        full = ROOT / p
        if full.is_dir():
            files |= {f for f in full.rglob("*.swift")}
        elif full.suffix == ".swift":
            if not full.exists():
                if not (isinstance(entry, dict) and entry.get("optional")):
                    fail.append(f"[1] {name}: missing source {p}")
            else:
                files.add(full)
        elif not full.exists() and not (isinstance(entry, dict) and entry.get("optional")):
            fail.append(f"[1] {name}: missing path {p}")
    target_files[name] = files
    for key in ("INFOPLIST_FILE", "CODE_SIGN_ENTITLEMENTS"):
        v = cfg.get("settings", {}).get("base", {}).get(key)
        if v and not (ROOT / v).exists():
            fail.append(f"[1] {name}: missing {key} -> {v}")
print(f"[1] project.yml OK: {len(targets)} targets")

# ---------- 2. orphan files ----------
claimed = set().union(*target_files.values())
allswift = set(ROOT.rglob("*.swift"))
for f in sorted(allswift - claimed):
    fail.append(f"[2] not compiled by any target: {f.relative_to(ROOT)}")
print(f"[2] {len(allswift)} swift files, {len(allswift - claimed)} orphaned")

# ---------- 3. delimiter balance ----------
def strip_noise(src):
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':
            if src[i:i+3] == '"""':
                j = src.find('"""', i+3)
                i = n if j < 0 else j+3
                continue
            i += 1
            while i < n and src[i] != '"':
                if src[i] == "\\": i += 1
                i += 1
            i += 1
            continue
        if src[i:i+2] == "//":
            j = src.find("\n", i); i = n if j < 0 else j
            continue
        if src[i:i+2] == "/*":
            j = src.find("*/", i+2); i = n if j < 0 else j+2
            continue
        out.append(c); i += 1
    return "".join(out)

for f in sorted(allswift):
    s = strip_noise(f.read_text())
    for open_c, close_c in [("{", "}"), ("(", ")"), ("[", "]")]:
        if s.count(open_c) != s.count(close_c):
            fail.append(f"[3] {f.relative_to(ROOT)}: {open_c}{close_c} "
                        f"{s.count(open_c)} vs {s.count(close_c)}")
print(f"[3] delimiter balance checked")

# ---------- 4. cross-target symbol reachability ----------
DECL = re.compile(r"^(?:@\w+\s+)*(?:public |internal |private |final |@MainActor )*"
                  r"(struct|enum|class|protocol|actor)\s+(\w+)", re.M)
decl_file = {}
for f in sorted(allswift):
    for _, name in DECL.findall(f.read_text()):
        decl_file[name] = f

for tname, files in sorted(target_files.items()):
    missing = collections.defaultdict(set)
    for f in files:
        body = strip_noise(f.read_text())
        for sym, home in decl_file.items():
            if home in files:
                continue
            if re.search(rf"\b{sym}\b", body):
                missing[sym].add(f.relative_to(ROOT).as_posix())
    for sym, users in sorted(missing.items()):
        fail.append(f"[4] {tname}: uses {sym} (declared in "
                    f"{decl_file[sym].relative_to(ROOT)}) but does not compile it "
                    f"-- used by {', '.join(sorted(users))}")
print(f"[4] cross-target symbols checked ({len(decl_file)} declared types)")

print()
if fail:
    print(f"{len(fail)} PROBLEM(S):")
    for f in fail: print("  " + f)
    sys.exit(1)
print("all structural checks pass")
