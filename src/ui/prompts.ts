import { cancel, confirm, isCancel, multiselect, note } from "@clack/prompts";
import { LrError, UsageError } from "../core/errors.js";

export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

export async function askConfirm(message: string, yes: boolean, initial = false): Promise<boolean> {
  if (yes) return true;
  if (!interactive()) throw new UsageError(`${message} (no terminal to ask; pass --yes to confirm)`);
  const answer = await confirm({ message, initialValue: initial });
  if (isCancel(answer)) {
    cancel("Cancelled.");
    throw new LrError("cancelled", "Cancelled by the user");
  }
  return answer;
}

export async function askAgents(enabled: string[], options: { value: string; label: string; hint?: string }[]): Promise<string[]> {
  if (!interactive()) throw new UsageError("No terminal for the agent picker", "Pass --agents codex,cursor --yes");
  if (enabled.length) note(`Enabled: ${enabled.join(", ")}`, "Looprch");
  if (options.length === 0) return [];
  const picked = await multiselect({
    message: "Select agents to add (Space to toggle, Enter to confirm)",
    options,
    required: false,
  });
  if (isCancel(picked)) {
    cancel("Cancelled.");
    throw new LrError("cancelled", "Cancelled by the user");
  }
  return picked as string[];
}
