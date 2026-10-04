import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(root, "VERSION"), `${pkg.version}\n`);
chmodSync(join(root, "dist", "looprch.mjs"), 0o755);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__" || name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const files = ["dist", "assets", "vendor", "schemas"].flatMap((d) => walk(join(root, d)));
files.push(join(root, "VERSION"));
const lines = files
  .map((f) => relative(root, f).split(sep).join("/"))
  .sort()
  .map((rel) => `${createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")}  ${rel}`);
writeFileSync(join(root, "MANIFEST.sha256"), `${lines.join("\n")}\n`);
