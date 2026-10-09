import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { packageRoot } from "../core/constants.js";
import { writeFileAtomic } from "../core/fsx.js";

/** The keys file `looprch e2e init` writes; e2e.config.ts and Looprch's gate runs load it. */
export const E2E_ENV_FILE = ".env.e2e";

export const E2E_PROVIDER_IDS = ["none", "openrouter", "openai", "anthropic", "google", "deepseek", "gateway", "openai-compatible"] as const;
export type E2eProviderId = (typeof E2E_PROVIDER_IDS)[number];

export interface EnvKey {
  name: string;
  what: string;
  /** Where the user gets the value. */
  where: string;
  required: boolean;
}

export interface E2eProvider {
  id: E2eProviderId;
  label: string;
  /** npm packages agent steps need, with ranges (spike S-12). */
  packages: string[];
  import: string | null;
  /** The AI SDK model expression; `model` is a TypeScript expression that yields the model id. */
  model: ((model: string) => string) | null;
  defaultModel: string;
  keys: EnvKey[];
}

const AI = ["ai@^7.0.0", "zod@^4.1.8"];

/** Provider presets verified in spike S-12; the lines match the runner's own `e2e init` presets. */
export const E2E_PROVIDERS: Record<E2eProviderId, E2eProvider> = {
  none: { id: "none", label: "No model (locator tests only, free)", packages: [], import: null, model: null, defaultModel: "", keys: [] },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (one key for many providers)",
    packages: [...AI, "@openrouter/ai-sdk-provider@^3.0.0"],
    import: "import { openrouter } from '@openrouter/ai-sdk-provider';",
    model: (m) => `openrouter(${m})`,
    defaultModel: "openai/gpt-6-luna-fast",
    keys: [{ name: "OPENROUTER_API_KEY", what: "your OpenRouter API key", where: "https://openrouter.ai/keys", required: true }],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    packages: [...AI, "@ai-sdk/openai@^4.0.0"],
    import: "import { openai } from '@ai-sdk/openai';",
    model: (m) => `openai(${m})`,
    defaultModel: "gpt-6-luna",
    keys: [{ name: "OPENAI_API_KEY", what: "your OpenAI API key", where: "https://platform.openai.com/api-keys", required: true }],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    packages: [...AI, "@ai-sdk/anthropic@^4.0.0"],
    import: "import { anthropic } from '@ai-sdk/anthropic';",
    model: (m) => `anthropic(${m})`,
    defaultModel: "claude-sonnet-5",
    keys: [{ name: "ANTHROPIC_API_KEY", what: "your Anthropic API key", where: "https://console.anthropic.com/settings/keys", required: true }],
  },
  google: {
    id: "google",
    label: "Google Gemini",
    packages: [...AI, "@ai-sdk/google@^4.0.0"],
    import: "import { google } from '@ai-sdk/google';",
    model: (m) => `google(${m})`,
    defaultModel: "gemini-3-flash",
    keys: [{ name: "GOOGLE_GENERATIVE_AI_API_KEY", what: "your Google AI Studio API key", where: "https://aistudio.google.com/apikey", required: true }],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    packages: [...AI, "@ai-sdk/deepseek@^3.0.0"],
    import: "import { deepseek } from '@ai-sdk/deepseek';",
    model: (m) => `deepseek(${m})`,
    defaultModel: "deepseek-chat",
    keys: [{ name: "DEEPSEEK_API_KEY", what: "your DeepSeek API key", where: "https://platform.deepseek.com/api_keys", required: true }],
  },
  gateway: {
    id: "gateway",
    label: "Vercel AI Gateway (one key for many providers)",
    packages: AI,
    import: "import { gateway } from 'ai';",
    model: (m) => `gateway(${m})`,
    defaultModel: "openai/gpt-6-luna-fast",
    keys: [{ name: "AI_GATEWAY_API_KEY", what: "your Vercel AI Gateway API key", where: "https://vercel.com/docs/ai-gateway", required: true }],
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, LiteLLM, a vendor API)",
    packages: [...AI, "@ai-sdk/openai-compatible@^3.0.0"],
    import: "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';",
    model: (m) => `createOpenAICompatible({ name: 'custom', baseURL: process.env.E2E_BASE_URL || '', apiKey: process.env.E2E_API_KEY || undefined }).chatModel(${m})`,
    defaultModel: "",
    keys: [
      { name: "E2E_BASE_URL", what: "the endpoint's /v1 URL, for example http://127.0.0.1:11434/v1 for Ollama", where: "your server's documentation", required: true },
      { name: "E2E_API_KEY", what: "the endpoint's API key (leave empty when the server needs none)", where: "your server or vendor", required: false },
    ],
  },
};

/** Runner and web engine, the versions spike S-11 verified together. */
export const E2E_RUNNER_PACKAGES = ["e2e@^0.18.0", "@e2e-dev/web@^0.13.0"];

export interface E2eInitOptions {
  provider: E2eProvider;
  model: string;
  url: string;
  /** Start command the runner launches (split on spaces; never shell-interpreted). */
  start: string | null;
  readyUrl: string | null;
  baseUrl: string | null;
}

/** Every variable the provider needs, plus the model id (non-secret, so it can change without editing the config). */
export function providerEnvKeys(p: E2eProvider): EnvKey[] {
  if (!p.model) return [];
  return [...p.keys, { name: "E2E_MODEL", what: "the model id the agent steps use", where: "your provider's model list", required: true }];
}

const tsString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The comment and line of one variable in the keys file. */
function envEntry(k: EnvKey, value: string): string {
  return `# ${k.what.charAt(0).toUpperCase()}${k.what.slice(1)}${k.required ? "" : " (optional)"}. Get it: ${k.where}\n${k.name}=${value}`;
}

export function renderE2eConfig(o: E2eInitOptions): string {
  const tpl = readFileSync(join(packageRoot(), "assets", "templates", "e2e", "e2e.config.ts.tpl"), "utf8");
  const p = o.provider;
  const agents = p.model
    ? `  agents: {\n    default: {\n      model: ${p.model(`process.env.E2E_MODEL || ${tsString(o.model)}`)},\n      system: 'You are a thorough QA agent. Verify every outcome.',\n    },\n  },\n`
    : "";
  const [exe, ...args] = (o.start ?? "").split(/\s+/).filter(Boolean);
  const command = exe ? `      command: { executable: ${tsString(exe)}, args: [${args.map(tsString).join(", ")}] },\n${o.readyUrl ? `      readyUrl: ${tsString(o.readyUrl)},\n` : ""}` : "";
  return tpl
    .replace("{{provider_import}}\n", p.import ? `${p.import}\n` : "")
    .replace("{{agents}}", agents)
    .replace("{{url}}", o.url.replace(/'/g, "\\'"))
    .replace("{{command}}", command);
}

export function smokeTest(): string {
  return readFileSync(join(packageRoot(), "assets", "templates", "e2e", "smoke.e2e.ts.tpl"), "utf8");
}

/** The keys file: every variable with a comment saying what it is and where to get it. */
export function renderEnvFile(o: E2eInitOptions): string {
  const values: Record<string, string> = { APP_URL: o.url, E2E_MODEL: o.model, E2E_BASE_URL: o.baseUrl ?? "" };
  const lines = [
    "# E2E test settings for the TesterArmy e2e runner, written by `looprch e2e init`.",
    "# Fill in the empty values, save, then run: looprch e2e configure --enable",
    "# This file holds secrets: it is gitignored; never commit it. A variable exported in your shell wins over this file.",
    "",
    "# The URL the tests open.",
    `APP_URL=${values.APP_URL}`,
  ];
  for (const k of providerEnvKeys(o.provider)) lines.push("", envEntry(k, values[k.name] ?? ""));
  return `${lines.join("\n")}\n`;
}

/** Lines for keys a keys file does not have yet (a re-run with another provider keeps existing values). */
export function missingEnvLines(existing: string, o: E2eInitOptions): string {
  const have = parseEnv(existing);
  const add = providerEnvKeys(o.provider).filter((k) => !(k.name in have));
  if (!add.length) return "";
  const values: Record<string, string> = { E2E_MODEL: o.model, E2E_BASE_URL: o.baseUrl ?? "" };
  return `${add.map((k) => `\n${envEntry(k, values[k.name] ?? "")}`).join("\n")}\n`;
}

/** Variables of the keys file, or {} when it does not exist. */
export function readEnvFile(root: string): Record<string, string> {
  const p = join(root, E2E_ENV_FILE);
  if (!existsSync(p)) return {};
  return parseEnv(readFileSync(p, "utf8")) as Record<string, string>;
}

/** Add `entry` to .gitignore unless a line already names it. */
export function ensureGitignored(root: string, entry: string): boolean {
  const p = join(root, ".gitignore");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (text.split("\n").some((l) => l.trim() === entry || l.trim() === `/${entry}`)) return false;
  writeFileAtomic(p, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`);
  return true;
}

/** True when the project already has an `*.e2e.ts` test under tests/ (the runner's default selection). */
export function hasE2eTests(root: string): boolean {
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 6 || !existsSync(dir)) return false;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory() ? walk(p, depth + 1) : name.endsWith(".e2e.ts")) return true;
    }
    return false;
  };
  return walk(join(root, "tests"), 0);
}

/** The install command of the project's package manager, chosen by its lockfile. */
export function installCommand(root: string, packages: string[]): string[] {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return ["pnpm", "add", "-D", ...packages];
  if (existsSync(join(root, "yarn.lock"))) return ["yarn", "add", "-D", ...packages];
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return ["bun", "add", "-d", ...packages];
  return ["npm", "install", "-D", ...packages];
}
