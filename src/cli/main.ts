import { HelpRequested, UsageError } from "../core/errors.js";
import { VERSION } from "../core/constants.js";
import { printError } from "./output.js";
import { run as version } from "./version.js";
import { run as install } from "./install.js";
import { run as update } from "./update.js";
import { run as rollback } from "./rollback.js";
import { run as uninstall } from "./uninstall.js";
import { run as selfTest } from "./selftest.js";
import { run as add } from "./add.js";
import { run as remove } from "./remove.js";
import { run as list } from "./list.js";
import { run as init } from "./init.js";
import { run as config } from "./config.js";
import { run as models } from "./models.js";
import { run as installRelay } from "./install-relay.js";
import { run as doctor } from "./doctor.js";
import { run as next } from "./next.js";
import { run as record } from "./record.js";
import { run as gates } from "./gates.js";
import { run as e2e } from "./e2e.js";
import { run as check } from "./check.js";
import { run as dispatch, runWrapper } from "./dispatch.js";
import { runAnswer, runCheckpoint, runPause, runResume, runWait } from "./flow.js";
import { runReview, runWorker } from "./side.js";
import { run as status, runLog } from "./status.js";

type Command = (argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  version,
  install,
  update,
  rollback,
  uninstall,
  "self-test": selfTest,
  add,
  remove,
  list,
  init,
  config,
  models,
  "install-relay": installRelay,
  doctor,
  next,
  record,
  check,
  gates,
  e2e,
  dispatch,
  answer: runAnswer,
  wait: runWait,
  pause: runPause,
  resume: runResume,
  checkpoint: runCheckpoint,
  worker: runWorker,
  review: runReview,
  status,
  log: runLog,
};

const HIDDEN: Record<string, Command> = {
  "_run-relay": runWrapper,
};

const USAGE = `looprch ${VERSION}

Usage: looprch <command> [options]

Commands: ${Object.keys(COMMANDS).sort().join(", ")}
Run "looprch <command> --help" for details. Most commands accept --json.`;

async function main(argv: string[]): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    process.stderr.write(`looprch needs Node.js 22 or newer (found ${process.versions.node}).\n`);
    return 1;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 0 : 2;
  }
  if (cmd === "--version" || cmd === "-v") return version([]);
  const handler = COMMANDS[cmd] ?? HIDDEN[cmd];
  const json = rest.includes("--json");
  if (!handler) return printError(new UsageError(`Unknown command "${cmd}"`, USAGE), json);
  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(`${err.usage}\n`);
      return 0;
    }
    return printError(err, json);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.exitCode = printError(err, false);
  },
);
