/**
 * GitHub stack topology.
 *
 * GitHub's native stack metadata is exposed on the GraphQL `PullRequest.stackEntry`
 * field — it is **not** present on the REST pull request resource, so topology
 * is read over GraphQL. Pull requests that were chained by hand rather than
 * through GitHub's stacking flow have no native stack, so the chain of base
 * branches is used to reconstruct the topology instead.
 *
 * All access goes through the authenticated `gh` CLI so stacklore inherits
 * existing credentials rather than asking for a second token.
 */

import {
  reasonFor,
  runCommand,
  type CommandRunner,
  type RunOptions,
} from "./exec.ts";
import type { StackPosition } from "./types.ts";

/** Upper bound on stack size, guarding chain walks against pathological input. */
const MAX_STACK = 50;

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
  head: { ref: string; repo?: { full_name?: string } | null };
  base: { ref: string };
}

interface GqlPullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  stackEntry?: {
    position?: number | null;
    stack?: {
      number?: number | null;
      size?: number | null;
      baseRefName?: string | null;
      entries?: {
        nodes?: ({
          position?: number | null;
          pullRequest?: GqlPullRequest | null;
        } | null)[];
      } | null;
    } | null;
  } | null;
}

export class GitHubError extends Error {}

const PR_FIELDS = "number title headRefName baseRefName state";

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      ${PR_FIELDS}
      stackEntry{
        position
        stack{
          number size baseRefName
          entries(first:${MAX_STACK}){ nodes{ position pullRequest{ ${PR_FIELDS} } } }
        }
      }
    }
  }
}`;

async function gh(
  exec: CommandRunner,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  try {
    return await exec("gh", args, options);
  } catch (error) {
    throw new GitHubError(`gh ${args.join(" ")} failed: ${reasonFor(error)}`);
  }
}

/**
 * Parse `gh api --paginate --jq '.[]'` output.
 *
 * Without `--jq`, `--paginate` emits one complete JSON array per page and
 * concatenates them, which is not valid JSON. Projecting with `.[]` yields one
 * object per line instead, which stays parseable across any number of pages.
 */
function parseJsonLines<T>(raw: string): T[] {
  const items: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(JSON.parse(trimmed) as T);
  }
  return items;
}

const NO_STACK: StackPosition = {
  number: null,
  position: null,
  size: null,
  base: null,
};

function gqlToInfo(pr: GqlPullRequest): PullRequestInfo {
  const entry = pr.stackEntry;
  const stack = entry?.stack;
  return {
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    // GraphQL reports OPEN/CLOSED/MERGED; REST reports open/closed. Normalise
    // to the REST casing so the two sources stay interchangeable.
    state: pr.state.toLowerCase(),
    stack: stack
      ? {
          number: stack.number ?? null,
          position: entry?.position ?? null,
          size: stack.size ?? null,
          base: stack.baseRefName ?? null,
          source: "github",
        }
      : { ...NO_STACK },
  };
}

function restToInfo(pr: RestPullRequest): PullRequestInfo {
  return {
    number: pr.number,
    title: pr.title,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    state: pr.state,
    stack: { ...NO_STACK },
  };
}

/** Read a single pull request, including stack membership when present. */
export async function getPullRequest(
  repo: string,
  pr: number,
  exec: CommandRunner = runCommand,
): Promise<PullRequestInfo> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new GitHubError(`expected 'owner/repo', got '${repo}'`);
  }
  const raw = await gh(exec, [
    "api",
    "graphql",
    "-f",
    `query=${PR_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${pr}`,
  ]);
  const data = JSON.parse(raw) as {
    data?: { repository?: { pullRequest?: GqlPullRequest | null } | null };
  };
  const node = data.data?.repository?.pullRequest;
  if (!node) throw new GitHubError(`pull request ${repo}#${pr} not found`);
  return gqlToInfo(node);
}

/** Every open pull request in the repository. */
async function listOpen(
  repo: string,
  exec: CommandRunner,
): Promise<PullRequestInfo[]> {
  const raw = await gh(exec, [
    "api",
    "--paginate",
    "--jq",
    ".[]",
    `repos/${repo}/pulls?state=open&per_page=100`,
  ]);
  return parseJsonLines<RestPullRequest>(raw).map(restToInfo);
}

/**
 * Reconstruct a stack from the chain of base branches.
 *
 * A stack is linear: each layer's base branch is the layer below it's head
 * branch. Walking that relation down to the trunk and back up recovers the same
 * ordering GitHub would report, for stacks that were chained by hand.
 *
 * Ascent stops at a branch point: when two open pull requests target the same
 * head, the topology is a tree rather than a stack and guessing a path would
 * misreport it.
 */
function inferChain(
  head: PullRequestInfo,
  open: PullRequestInfo[],
): PullRequestInfo[] {
  const byHead = new Map<string, PullRequestInfo>();
  const childrenOf = new Map<string, PullRequestInfo[]>();
  for (const pr of open) {
    byHead.set(pr.branch, pr);
    const siblings = childrenOf.get(pr.baseBranch) ?? [];
    siblings.push(pr);
    childrenOf.set(pr.baseBranch, siblings);
  }

  const seen = new Set<number>([head.number]);
  const chain = [head];

  let cursor = head;
  while (chain.length < MAX_STACK) {
    const parent = byHead.get(cursor.baseBranch);
    if (!parent || seen.has(parent.number)) break;
    seen.add(parent.number);
    chain.unshift(parent);
    cursor = parent;
  }

  cursor = head;
  while (chain.length < MAX_STACK) {
    const children = childrenOf.get(cursor.branch) ?? [];
    const child = children.length === 1 ? children[0] : undefined;
    if (!child || seen.has(child.number)) break;
    seen.add(child.number);
    chain.push(child);
    cursor = child;
  }

  return chain;
}

/**
 * Return every pull request in the same stack as `pr`, ordered bottom-to-top.
 *
 * Falls back to a single-element list when the pull request is standalone, so
 * callers can treat standalone pull requests as a stack of one.
 */
export async function getStack(
  repo: string,
  pr: number,
  exec: CommandRunner = runCommand,
): Promise<PullRequestInfo[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new GitHubError(`expected 'owner/repo', got '${repo}'`);
  }
  const raw = await gh(exec, [
    "api",
    "graphql",
    "-f",
    `query=${PR_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${pr}`,
  ]);
  const node = (
    JSON.parse(raw) as {
      data?: { repository?: { pullRequest?: GqlPullRequest | null } | null };
    }
  ).data?.repository?.pullRequest;
  if (!node) throw new GitHubError(`pull request ${repo}#${pr} not found`);

  const head = gqlToInfo(node);

  // A GitHub-native stack carries every member with it, already positioned.
  const entries = node.stackEntry?.stack?.entries?.nodes ?? [];
  const members: PullRequestInfo[] = [];
  for (const entry of entries) {
    const member = entry?.pullRequest;
    if (!member) continue;
    members.push({
      ...gqlToInfo(member),
      stack: {
        number: node.stackEntry?.stack?.number ?? null,
        position: entry.position ?? null,
        size: node.stackEntry?.stack?.size ?? null,
        base: node.stackEntry?.stack?.baseRefName ?? null,
        source: "github",
      },
    });
  }

  if (members.length > 0) {
    members.sort((a, b) => {
      const byPosition =
        (a.stack.position ?? Number.MAX_SAFE_INTEGER) -
        (b.stack.position ?? Number.MAX_SAFE_INTEGER);
      return byPosition !== 0 ? byPosition : a.number - b.number;
    });
    return members;
  }

  // No native stack. Reconstruct from base branches.
  const chain = inferChain(head, await listOpen(repo, exec));
  if (chain.length <= 1) return [head];

  const bottom = chain[0];
  return chain.map((member, index) => ({
    ...member,
    stack: {
      number: null,
      position: index + 1,
      size: chain.length,
      base: bottom?.baseBranch ?? null,
      source: "inferred",
    },
  }));
}

/** Resolve `owner/repo` for the current working directory. */
export async function currentRepo(
  exec: CommandRunner = runCommand,
): Promise<string> {
  const raw = await gh(exec, [
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
export async function currentBranch(
  exec: CommandRunner = runCommand,
): Promise<string> {
  return (await exec("git", ["branch", "--show-current"])).trim();
}

/**
 * Find the open pull request whose head is `branch`, if any.
 *
 * The `head` query filter is deliberately not used: it requires the head
 * *owner*, which differs from the base repository owner for fork-based pull
 * requests. Listing and matching on `head.ref` is correct in both cases and
 * sidesteps encoding branch names that contain a slash.
 */
export async function pullRequestForBranch(
  repo: string,
  branch: string,
  exec: CommandRunner = runCommand,
): Promise<number | null> {
  const open = await listOpen(repo, exec);
  return open.find((p) => p.branch === branch)?.number ?? null;
}

/** Post or update a single stacklore comment on a pull request. */
export async function upsertComment(
  repo: string,
  pr: number,
  body: string,
  marker: string,
  exec: CommandRunner = runCommand,
): Promise<void> {
  const raw = await gh(exec, [
    "api",
    "--paginate",
    "--jq",
    ".[]",
    `repos/${repo}/issues/${pr}/comments?per_page=100`,
  ]);
  const comments = parseJsonLines<{ id: number; body?: string }>(raw);
  const existing = comments.find((c) => c.body?.includes(marker));

  // Sent on stdin rather than as `-f body=…`: comment bodies are unbounded
  // markdown and command-line arguments are not.
  const payload = JSON.stringify({ body: `${marker}\n${body}` });

  const endpoint = existing
    ? [`repos/${repo}/issues/comments/${existing.id}`, "--method", "PATCH"]
    : [`repos/${repo}/issues/${pr}/comments`, "--method", "POST"];

  await gh(exec, ["api", ...endpoint, "--input", "-"], { stdin: payload });
}
