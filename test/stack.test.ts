import assert from "node:assert/strict";
import { test } from "node:test";

import type { CommandRunner } from "../src/exec.ts";
import { runner } from "./helpers.ts";
import {
  GitHubError,
  currentBranch,
  currentRepo,
  getPullRequest,
  getStack,
  pullRequestForBranch,
  upsertComment,
} from "../src/stack.ts";

function gqlPr(
  number: number,
  branch: string,
  base: string,
  extra: Record<string, unknown> = {},
) {
  return {
    number,
    title: `PR ${number}`,
    headRefName: branch,
    baseRefName: base,
    state: "OPEN",
    ...extra,
  };
}

function graphql(pullRequest: unknown): string {
  return JSON.stringify({ data: { repository: { pullRequest } } });
}

function restPr(number: number, branch: string, base: string) {
  return JSON.stringify({
    number,
    title: `PR ${number}`,
    state: "open",
    head: { ref: branch },
    base: { ref: base },
  });
}

test("stack topology is read over GraphQL, which is the only API that exposes it", async () => {
  const { exec, calls } = runner([
    ["api graphql", graphql(gqlPr(7, "feature", "main", { stackEntry: null }))],
  ]);

  const pr = await getPullRequest("acme/widgets", 7, exec);

  assert.equal(pr.number, 7);
  assert.equal(pr.branch, "feature");
  // GraphQL reports OPEN; the REST casing is the contract.
  assert.equal(pr.state, "open");
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["api", "graphql"]);
});

test("a pull request with no stack reports an empty position", async () => {
  const { exec } = runner([
    ["api graphql", graphql(gqlPr(7, "feature", "main", { stackEntry: null }))],
  ]);

  const pr = await getPullRequest("acme/widgets", 7, exec);

  assert.deepEqual(pr.stack, {
    number: null,
    position: null,
    size: null,
    base: null,
  });
});

test("a standalone pull request is treated as a stack of one", async () => {
  const { exec } = runner([
    ["api graphql", graphql(gqlPr(7, "feature", "main", { stackEntry: null }))],
    // The only other open pull request is unrelated: different base, and it is
    // not a child of `feature`.
    ["repos/acme/widgets/pulls", [restPr(7, "feature", "main"), restPr(9, "other", "main")].join("\n")],
  ]);

  const stack = await getStack("acme/widgets", 7, exec);

  assert.equal(stack.length, 1);
  assert.equal(stack[0]?.number, 7);
  assert.equal(stack[0]?.stack.position, null);
  assert.equal(stack[0]?.stack.size, null);
});

test("a GitHub-native stack is ordered bottom-to-top by position", async () => {
  const entries = [
    { position: 3, pullRequest: gqlPr(43, "layer-3", "layer-2") },
    { position: 1, pullRequest: gqlPr(41, "layer-1", "main") },
    { position: 2, pullRequest: gqlPr(42, "layer-2", "layer-1") },
  ];
  const { exec } = runner([
    [
      "api graphql",
      graphql(
        gqlPr(42, "layer-2", "layer-1", {
          stackEntry: {
            position: 2,
            stack: {
              number: 5,
              size: 3,
              baseRefName: "main",
              entries: { nodes: entries },
            },
          },
        }),
      ),
    ],
  ]);

  const stack = await getStack("acme/widgets", 42, exec);

  assert.deepEqual(
    stack.map((p) => p.number),
    [41, 42, 43],
  );
  assert.deepEqual(
    stack.map((p) => p.stack.position),
    [1, 2, 3],
  );
  assert.equal(stack[0]?.stack.number, 5);
  assert.equal(stack[0]?.stack.base, "main");
  assert.equal(stack[0]?.stack.source, "github");
});

test("a hand-chained stack is inferred from base branches, bottom-to-top", async () => {
  const { exec } = runner([
    ["api graphql", graphql(gqlPr(42, "layer-2", "layer-1", { stackEntry: null }))],
    [
      "repos/acme/widgets/pulls",
      [
        restPr(43, "layer-3", "layer-2"),
        restPr(41, "layer-1", "main"),
        restPr(42, "layer-2", "layer-1"),
      ].join("\n"),
    ],
  ]);

  const stack = await getStack("acme/widgets", 42, exec);

  assert.deepEqual(
    stack.map((p) => p.number),
    [41, 42, 43],
  );
  assert.deepEqual(
    stack.map((p) => p.stack.position),
    [1, 2, 3],
  );
  assert.equal(stack[0]?.stack.size, 3);
  assert.equal(stack[0]?.stack.base, "main");
  assert.equal(stack[0]?.stack.source, "inferred");
  // There is no GitHub stack id to report for an inferred chain.
  assert.equal(stack[0]?.stack.number, null);
});

test("inference stops at a branch point rather than guessing a path", async () => {
  const { exec } = runner([
    ["api graphql", graphql(gqlPr(41, "layer-1", "main", { stackEntry: null }))],
    [
      "repos/acme/widgets/pulls",
      [
        restPr(41, "layer-1", "main"),
        restPr(42, "fork-a", "layer-1"),
        restPr(43, "fork-b", "layer-1"),
      ].join("\n"),
    ],
  ]);

  const stack = await getStack("acme/widgets", 41, exec);

  assert.equal(stack.length, 1);
  assert.equal(stack[0]?.number, 41);
});

test("inference terminates on a cycle", async () => {
  const { exec } = runner([
    ["api graphql", graphql(gqlPr(1, "a", "b", { stackEntry: null }))],
    [
      "repos/acme/widgets/pulls",
      [restPr(1, "a", "b"), restPr(2, "b", "a")].join("\n"),
    ],
  ]);

  const stack = await getStack("acme/widgets", 1, exec);

  assert.ok(stack.length <= 2);
});

test("paginated responses parse as JSON lines, not concatenated arrays", async () => {
  // `gh api --paginate` emits one array per page; `--jq '.[]'` flattens that to
  // one object per line. Parsing the raw concatenation would throw here.
  const pages = [
    restPr(1, "a", "main"),
    restPr(2, "b", "main"),
    "",
    restPr(3, "target", "main"),
  ].join("\n");
  const { exec, calls } = runner([["repos/acme/widgets/pulls", pages]]);

  assert.equal(await pullRequestForBranch("acme/widgets", "target", exec), 3);
  assert.ok(calls[0]?.args.includes("--paginate"));
  assert.ok(calls[0]?.args.includes("--jq"));
});

test("branch lookup matches head refs directly, so forks and slashes work", async () => {
  const { exec, calls } = runner([
    [
      "repos/acme/widgets/pulls",
      [restPr(1, "main", "main"), restPr(8, "user/fix/thing", "main")].join("\n"),
    ],
  ]);

  assert.equal(
    await pullRequestForBranch("acme/widgets", "user/fix/thing", exec),
    8,
  );
  // A `head=owner:branch` filter would be wrong for fork-based pull requests.
  assert.ok(!calls[0]?.args.join(" ").includes("head="));
});

test("an unknown branch yields null rather than throwing", async () => {
  const { exec } = runner([
    ["repos/acme/widgets/pulls", restPr(1, "main", "main")],
  ]);
  assert.equal(await pullRequestForBranch("acme/widgets", "absent", exec), null);
});

test("a malformed repository is rejected before any network call", async () => {
  const { exec, calls } = runner([]);
  await assert.rejects(
    () => getPullRequest("not-a-repo", 1, exec),
    (error: unknown) => error instanceof GitHubError,
  );
  assert.equal(calls.length, 0);
});

test("a missing pull request is reported, not silently empty", async () => {
  const { exec } = runner([["api graphql", graphql(null)]]);
  await assert.rejects(
    () => getPullRequest("acme/widgets", 404, exec),
    /not found/,
  );
});

test("a new comment is created with the marker, via stdin", async () => {
  const { exec, calls } = runner([
    ["issues/5/comments?per_page", ""],
    ["--method POST", "{}"],
  ]);

  await upsertComment("acme/widgets", 5, "line one\nline two", "<!-- m -->", exec);

  const post = calls.find((c) => c.args.includes("POST"));
  assert.ok(post, "expected a POST");
  // The body travels on stdin: comment bodies are unbounded, argv is not.
  assert.ok(post?.args.includes("--input"));
  assert.deepEqual(JSON.parse(post?.stdin ?? "{}"), {
    body: "<!-- m -->\nline one\nline two",
  });
});

test("an existing stacklore comment is updated rather than duplicated", async () => {
  const { exec, calls } = runner([
    [
      "issues/5/comments?per_page",
      [
        JSON.stringify({ id: 1, body: "unrelated chatter" }),
        JSON.stringify({ id: 2, body: "<!-- m -->\nold lore" }),
      ].join("\n"),
    ],
    ["--method PATCH", "{}"],
  ]);

  await upsertComment("acme/widgets", 5, "new lore", "<!-- m -->", exec);

  const patch = calls.find((c) => c.args.includes("PATCH"));
  assert.ok(patch, "expected a PATCH");
  assert.ok(patch?.args.some((a) => a.includes("issues/comments/2")));
  assert.equal(
    calls.filter((c) => c.args.includes("POST")).length,
    0,
    "must not also post a duplicate",
  );
});

test("comment bodies survive markdown that would break shell quoting", async () => {
  const body = [
    "| a | b |",
    "|---|---|",
    "| `x=1` | $(whoami) |",
    '"quoted" and \\backslash\\ and 🪶',
  ].join("\n");
  const { exec, calls } = runner([
    ["issues/5/comments?per_page", ""],
    ["--method POST", "{}"],
  ]);

  await upsertComment("acme/widgets", 5, body, "<!-- m -->", exec);

  const post = calls.find((c) => c.args.includes("POST"));
  assert.equal(
    (JSON.parse(post?.stdin ?? "{}") as { body: string }).body,
    `<!-- m -->\n${body}`,
  );
});

test("repository and branch are read from the working directory", async () => {
  const { exec } = runner([
    ["repo view", "acme/widgets\n"],
    ["branch --show-current", "feature\n"],
  ]);

  assert.equal(await currentRepo(exec), "acme/widgets");
  assert.equal(await currentBranch(exec), "feature");
});

test("a failing gh invocation surfaces as GitHubError", async () => {
  const exec: CommandRunner = async () => {
    throw new Error("gh: not authenticated");
  };
  await assert.rejects(
    () => getPullRequest("acme/widgets", 1, exec),
    (error: unknown) =>
      error instanceof GitHubError && /not authenticated/.test(error.message),
  );
});
