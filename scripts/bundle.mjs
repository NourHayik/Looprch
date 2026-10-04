import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/looprch.mjs",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __lrCreateRequire } from 'node:module'; const require = __lrCreateRequire(import.meta.url);",
  },
  define: { __LOOPRCH_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
