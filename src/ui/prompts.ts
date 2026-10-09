import { cancel, confirm, isCancel, multiselect, note, select, text } from "@clack/prompts";
import { LrError, UsageError } from "../core/errors.js";

export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function answered<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    throw new LrError("cancelled", "Cancelled by the user");
  }
  return value as T;
}

export async function askSelect(message: string, options: { value: string; label: string; hint?: string }[], initial?: string): Promise<string> {
  if (!interactive()) throw new UsageError(`${message} (no terminal to ask)`);
  return answered(await select({ message, options, ...(initial ? { initialValue: initial } : {}) })) as string;
}

export async function askText(message: string, initial: string, placeholder?: string): Promise<string> {
  if (!interactive()) throw new UsageError(`${message} (no terminal to ask)`);
  return (answered(await text({ message, initialValue: initial, ...(placeholder ? { placeholder } : {}) })) as string).trim();
}

export async function askConfirm(message: string, yes: boolean, initial = false): Promise<boolean> {
  if (yes) return true;
  if (!interactive()) throw new UsageError(`${message} (no terminal to ask; pass --yes to confirm)`);
  return answered<boolean>(await confirm({ message, initialValue: initial }));
}

export async function askAgents(enabled: string[], options: { value: string; label: string; hint?: string }[]): Promise<string[]> {
  if (!interactive()) throw new UsageError("No terminal for the agent picker", "Pass --agents codex,cursor --yes");
  if (enabled.length) note(`Enabled: ${enabled.join(", ")}`, "Looprch");
  if (options.length === 0) return [];
  return answered(await multiselect({ message: "Select agents to add (Space to toggle, Enter to confirm)", options, required: false })) as string[];
}
