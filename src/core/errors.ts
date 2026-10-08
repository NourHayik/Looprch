export class LrError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly exitCode: number = 1,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class UsageError extends LrError {
  constructor(message: string, hint?: string) {
    super("usage", message, hint, 2);
  }
}

/** `--help` on any command: print its usage and exit 0, before the command does anything. */
export class HelpRequested extends Error {
  constructor(public readonly usage: string) {
    super(usage);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
