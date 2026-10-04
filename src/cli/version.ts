import { PROTOCOL, TOOLKIT_VERSION, VERSION } from "../core/constants.js";
import { looprchHome } from "../core/paths.js";
import { parse } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, {}, "looprch version [--json]");
  const data = { version: VERSION, protocol: PROTOCOL, toolkit_version: TOOLKIT_VERSION, node: process.versions.node, platform: process.platform, home: looprchHome() };
  out(!!values.json, data, `looprch ${VERSION} (protocol ${PROTOCOL}, SEV3 toolkit ${TOOLKIT_VERSION}, node ${data.node})`);
  return 0;
}
