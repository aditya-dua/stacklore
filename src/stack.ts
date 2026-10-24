/**
 * GitHub stack topology.
 *
 * Stacked pull requests expose a `stack` object on the pull request REST
 * resource when the pull request belongs to a stack. All access goes through
 * the authenticated `gh` CLI so stacklore inherits existing credentials rather
 * than asking for a second token.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { StackPosition } from "./types.js";

const execFileAsync = promisify(execFile);

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  state: string;
  stack: StackPosition;
}

interface RestPullRequest {
  number: number;
  title: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
  stack?: {
    number?: number;
    position?: number;
    size?: number;
    base?: string;
    base_branch?: string;
  } | null;
}

export class GitHubError extends Error {}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? error.message)
        : String(error);
    throw new GitHubError(`gh ${args.join(" ")} failed: ${message.trim()}`);
  }
}

function toStackPosition(pr: RestPullRequest): StackPosition {
  const s = pr.stack;
  if (!s) {
    return { number: null, position: null, size: null, base: null };
  }
  return {
    number: s.number ?? null,
    position: s.position ?? null,
    size: s.size ?? null,
    base: s.base ?? s.base_branch ?? null,
  };
}

/** Read a single pull request, including stack membership when present. */
export async function getPullRequest(
  repo: string,
  pr: number,
): Promise<PullRequestInfo> {
  const raw = await gh(["api", `repos/${repo}/pulls/${pr}`]);
  const data = JSON.parse(raw) as RestPullRequest;
  return {
    number: data.number,
    title: data.title,
    branch: data.head.ref,
    baseBranch: data.base.ref,
    state: data.state,
    stack: toStackPosition(data),
  };
}

/**
 * Return every pull request in the same stack as `pr`, ordered bottom-to-top.
 *
 * Falls back to a single-element list when the pull request is not stacked, so
 * callers can treat standalone pull requests as a stack of one.
 */
export async function getStack(
  repo: string,
  pr: number,
): Promise<PullRequestInfo[]> {
  const head = await getPullRequest(repo, pr);
  if (head.stack.number === null) return [head];

  const raw = await gh([
    "api",
    "--paginate",
    `repos/${repo}/pulls?state=open&per_page=100`,
  ]);
  const all = JSON.parse(raw) as RestPullRequest[];

  const members = all
    .filter((p) => p.stack?.number === head.stack.number)
    .map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.head.ref,
      baseBranch: p.base.ref,
      state: p.state,
      stack: toStackPosition(p),
    }));

  if (members.length === 0) return [head];

  members.sort((a, b) => (a.stack.position ?? 0) - (b.stack.position ?? 0));
  return members;
}

/** Resolve `owner/repo` for the current working directory. */
export async function currentRepo(): Promise<string> {
  const raw = await gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  return raw.trim();
}

/** Current git branch, used to infer which layer the user is on. */
export async function currentBranch(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"]);
  return stdout.trim();
}

/** Find the open pull request whose head is `branch`, if any. */
export async function pullRequestForBranch(
  repo: string,
  branch: string,
): Promise<number | null> {
  const owner = repo.split("/")[0];
  const raw = await gh([
    "api",
    `repos/${repo}/pulls?state=open&head=${owner}:${branch}`,
  ]);
  const list = JSON.parse(raw) as RestPullRequest[];
  return list[0]?.number ?? null;
}

/** Post or update a single stacklore comment on a pull request. */
export async function upsertComment(
  repo: string,
  pr: number,
  body: string,
  marker: string,
): Promise<void> {
  const raw = await gh(["api", `repos/${repo}/issues/${pr}/comments`]);
  const comments = JSON.parse(raw) as { id: number; body: string }[];
  const existing = comments.find((c) => c.body?.includes(marker));

  const payload = `${marker}\n${body}`;

  if (existing) {
    await gh([
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-f",
      `body=${payload}`,
    ]);
    return;
  }

  await gh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/issues/${pr}/comments`,
    "-f",
    `body=${payload}`,
  ]);
}
