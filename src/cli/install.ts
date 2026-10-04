import { resolve } from "node:path";
import { packageRoot } from "../core/constants.js";
import { home } from "../core/paths.js";
import { installVersion, switchCurrent } from "../install/central.js";
import { writeShim } from "../install/shim.js";
import { parse } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { from: { type: "string" } }, "looprch install [--from <package dir>] [--json]");
  const src = values.from ? resolve(values.from) : packageRoot();
  const { version, reused } = installVersion(src);
  switchCurrent(version);
  const shim = writeShim();
  const data = { version, home: home.root(), reused, shim: shim.path, shim_written: shim.written, shim_foreign: shim.foreign, on_path: shim.on_path, path_hint: shim.path_hint };
  out(!!values.json, data, () => {
    const lines = [`Installed Looprch ${version} into ${home.version(version)}${reused ? " (already present)" : ""}`, `current -> versions/${version}`];
    if (shim.foreign) lines.push(`warning: ${shim.path} exists and was not created by Looprch; left unchanged`);
    else lines.push(`shim: ${shim.path}`);
    if (shim.path_hint) lines.push(`~/.local/bin is not on PATH. Add:\n  ${shim.path_hint}`);
    return lines.join("\n");
  });
  return 0;
}
