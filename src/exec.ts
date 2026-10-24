/**
 * Subprocess seam.
 *
 * Every outbound call to `gh`, `git` and `sqlite3` goes through a
 * `CommandRunner`. Modules accept one by injection so tests can substitute a
 * fake without touching the network or the filesystem, and so the default
 * remains a plain `spawn` in production.
 *
 * `spawn` rather than `execFile` because `gh api --input -` needs a body on
 * stdin: command-line argument length is bounded, pull request comment bodies
 * are not.
 */

import { spawn } from "node:child_process";

export interface RunOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
}

/** Runs a command and resolves with its stdout. Rejects on a non-zero exit. */
export interface CommandRunner {
  (file: string, args: string[], options?: RunOptions): Promise<string>;
}

export class CommandError extends Error {
  readonly file: string;
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(
    file: string,
    args: string[],
    code: number | null,
    stderr: string,
  ) {
    super(`${file} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`);
    this.name = "CommandError";
    this.file = file;
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Default runner: spawn the binary directly, never via a shell. */
export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new CommandError(
          file,
          args,
          code,
          Buffer.concat(stderr).toString("utf8"),
        ),
      );
    });

    if (options.stdin !== undefined) {
      child.stdin?.on("error", reject);
      child.stdin?.end(options.stdin);
    }
  });

/** Extract a human-readable reason from an arbitrary thrown value. */
export function reasonFor(error: unknown): string {
  if (error instanceof CommandError) return error.stderr.trim() || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
