/**
 * Shared test doubles.
 *
 * Every module that touches the outside world takes a `CommandRunner`, so the
 * whole `gh`/`git` surface can be faked without a network or a real clone.
 */

import type { CommandRunner } from "../src/exec.ts";

export interface Call {
  file: string;
  args: string[];
  stdin?: string;
}

/**
 * Fake subprocess runner. Responses are matched as substrings of the joined
 * argument list, so a test only has to describe the calls it cares about. An
 * unrouted command throws rather than silently returning empty output, which
 * is what catches a test that forgot to inject this runner.
 */
export function runner(
  routes: [match: string, response: string | (() => string)][],
): { exec: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const exec: CommandRunner = async (file, args, options) => {
    calls.push({
      file,
      args,
      ...(options?.stdin ? { stdin: options.stdin } : {}),
    });
    const key = `${file} ${args.join(" ")}`;
    for (const [match, response] of routes) {
      if (key.includes(match)) {
        return typeof response === "function" ? response() : response;
      }
    }
    throw new Error(`unrouted command: ${key}`);
  };
  return { exec, calls };
}

/** Joined argument lists, for asserting on what actually ran. */
export function commandLines(calls: Call[]): string[] {
  return calls.map((call) => `${call.file} ${call.args.join(" ")}`);
}
