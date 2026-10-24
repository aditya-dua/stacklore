import assert from "node:assert/strict";
import { test } from "node:test";

import { runner } from "./helpers.ts";
import { captureLayer, captureStack } from "../src/capture.ts";
import type {
  CaptureAdapter,
  CaptureQuery,
  CaptureResult,
} from "../src/adapters/index.ts";
import type { PullRequestInfo } from "../src/stack.ts";
import { SCHEMA_VERSION } from "../src/types.ts";

/**
 * Adapter double. Captures are keyed by branch so a stack can be described in
 * one literal, and every query is recorded to assert on probing behaviour.
 */
function adapterFor(
  byBranch: Record<string, CaptureResult[]>,
  options: { available?: boolean; name?: string } = {},
): { adapter: CaptureAdapter; queries: CaptureQuery[]; probes: number } {
  const queries: CaptureQuery[] = [];
  const state = { probes: 0 };
  const adapter: CaptureAdapter = {
    name: options.name ?? "fake",
    async isAvailable() {
      state.probes += 1;
      return options.available ?? true;
    },
    async capture(query) {
      queries.push(query);
      return byBranch[query.branch] ?? [];
    },
  };
  return {
    adapter,
    queries,
    get probes() {
      return state.probes;
    },
  };
}

function capture(
  branch: string,
  exchanges: { turn: number; at: string; prompt: string; response?: string }[],
  extra: Partial<CaptureResult> = {},
): CaptureResult {
  return {
    tool: "fake-tool",
    adapter: "fake",
    sessionId: `session-${branch}`,
    branch,
    summary: null,
    exchanges,
    files: [],
    ...extra,
  };
}

function pr(
  number: number,
  branch: string,
  stack: Partial<PullRequestInfo["stack"]> = {},
): PullRequestInfo {
  return {
    number,
    title: `PR ${number}`,
    branch,
    baseBranch: "main",
    state: "open",
    stack: { number: null, position: null, size: null, base: null, ...stack },
  };
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

function noStack(number: number, branch: string, base: string) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number,
          title: `PR ${number}`,
          headRefName: branch,
          baseRefName: base,
          state: "OPEN",
          stackEntry: null,
        },
      },
    },
  });
}

test("a branch with no recorded session yields no record at all", async () => {
  // An empty record would publish a pull request comment promising context
  // that does not exist, which is worse than staying silent.
  const { adapter } = adapterFor({});

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
  });

  assert.equal(record, null);
});

test("a session with no exchanges still yields no record", async () => {
  const { adapter } = adapterFor({ "layer-1": [] });

  assert.equal(
    await captureLayer(pr(1, "layer-1"), { repo: "acme/widgets", adapter }),
    null,
  );
});

test("an unavailable adapter yields no record rather than throwing", async () => {
  const probe = adapterFor({}, { available: false });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapters: [probe.adapter],
  });

  assert.equal(record, null);
  assert.equal(probe.probes, 1);
});

test("secrets are redacted downstream of the adapter", async () => {
  // Adapters deliberately return raw data; redaction is the pipeline's job so
  // no adapter can forget to do it.
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        {
          turn: 0,
          at: "2024-01-01T00:00:00.000Z",
          prompt: "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 to push",
        },
      ]),
    ],
  });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
  });

  assert.ok(!record?.exchanges[0]?.prompt.includes("ghp_ABCDEFGHIJ"));
  assert.ok((record?.redactions.count ?? 0) > 0);
  assert.ok(record?.redactions.rules.length);
});

test("responses are redacted too, when captured", async () => {
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        {
          turn: 0,
          at: "2024-01-01T00:00:00.000Z",
          prompt: "deploy it",
          response: "I used ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        },
      ]),
    ],
  });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
    includeResponses: true,
  });

  assert.ok(!record?.exchanges[0]?.response?.includes("ghp_ABCDEFGHIJ"));
});

test("file paths are deduped, sorted and redacted", async () => {
  const { adapter } = adapterFor({
    "layer-1": [
      capture(
        "layer-1",
        [{ turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "work" }],
        { files: ["src/b.ts", "src/a.ts", "src/b.ts"] },
      ),
      capture(
        "layer-1",
        [{ turn: 1, at: "2024-01-01T01:00:00.000Z", prompt: "more" }],
        { sessionId: "second", files: ["src/a.ts", "src/c.ts"] },
      ),
    ],
  });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
  });

  assert.deepEqual(record?.files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("exchanges from several sessions merge in chronological order", async () => {
  // One branch is often worked across several sessions; the transcript has to
  // read in the order the work actually happened.
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        { turn: 2, at: "2024-01-02T00:00:00.000Z", prompt: "third" },
        { turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "first" },
      ]),
      capture(
        "layer-1",
        [{ turn: 1, at: "2024-01-01T12:00:00.000Z", prompt: "second" }],
        { sessionId: "other" },
      ),
    ],
  });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
  });

  assert.deepEqual(
    record?.exchanges.map((exchange) => exchange.prompt),
    ["first", "second", "third"],
  );
});

test("records are keyed by pull request, not by commit", async () => {
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        { turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "add the widget" },
      ]),
    ],
  });

  const record = await captureLayer(
    pr(42, "layer-1", { number: 7, position: 1, size: 3, base: "main" }),
    { repo: "acme/widgets", adapter },
  );

  assert.equal(record?.pr, 42);
  assert.equal(record?.repo, "acme/widgets");
  assert.equal(record?.schemaVersion, SCHEMA_VERSION);
  assert.equal(record?.stack.position, 1);
  assert.ok(!Object.keys(record ?? {}).some((key) => /sha|commit/i.test(key)));
});

test("intent is distilled from the prompts", async () => {
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        { turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "thanks!" },
        {
          turn: 1,
          at: "2024-01-01T01:00:00.000Z",
          prompt: "Extract the rate limiter so retries are testable",
        },
      ]),
    ],
  });

  const record = await captureLayer(pr(1, "layer-1"), {
    repo: "acme/widgets",
    adapter,
  });

  assert.match(record?.intent ?? "", /rate limiter/i);
});

test("the adapter is told which repository it is capturing for", async () => {
  // Branch names collide across repositories, so the repo has to be passed
  // through for the adapter to disambiguate.
  const { adapter, queries } = adapterFor({});

  await captureLayer(pr(1, "layer-1"), { repo: "acme/widgets", adapter });

  assert.equal(queries[0]?.repo, "acme/widgets");
  assert.equal(queries[0]?.branch, "layer-1");
  assert.equal(queries[0]?.includeResponses, false);
});

test("a standalone pull request is captured as a stack of one", async () => {
  const { exec } = runner([
    ["api graphql", noStack(9, "solo", "main")],
    ["repos/acme/widgets/pulls", restPr(9, "solo", "main")],
  ]);
  const { adapter } = adapterFor({
    solo: [
      capture("solo", [
        { turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "fix the typo" },
      ]),
    ],
  });

  const stack = await captureStack("acme/widgets", 9, { adapter, exec });

  assert.equal(stack.layers.length, 1);
  assert.equal(stack.layers[0]?.pr, 9);
  assert.equal(stack.stackNumber, null);
  assert.equal(stack.base, "main");
});

test("stack layers are captured bottom-to-top", async () => {
  const { exec } = runner([
    ["api graphql", noStack(2, "layer-2", "layer-1")],
    [
      "repos/acme/widgets/pulls",
      [
        restPr(1, "layer-1", "main"),
        restPr(2, "layer-2", "layer-1"),
        restPr(3, "layer-3", "layer-2"),
      ].join("\n"),
    ],
  ]);
  const { adapter } = adapterFor({
    "layer-1": [
      capture("layer-1", [
        { turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "bottom" },
      ]),
    ],
    "layer-2": [
      capture("layer-2", [
        { turn: 0, at: "2024-01-02T00:00:00.000Z", prompt: "middle" },
      ]),
    ],
    "layer-3": [
      capture("layer-3", [
        { turn: 0, at: "2024-01-03T00:00:00.000Z", prompt: "top" },
      ]),
    ],
  });

  const stack = await captureStack("acme/widgets", 2, { adapter, exec });

  assert.deepEqual(
    stack.layers.map((layer) => layer.pr),
    [1, 2, 3],
  );
  assert.deepEqual(
    stack.layers.map((layer) => layer.stack.position),
    [1, 2, 3],
  );
});

test("layers without sessions are skipped, not emitted empty", async () => {
  const { exec } = runner([
    ["api graphql", noStack(2, "layer-2", "layer-1")],
    [
      "repos/acme/widgets/pulls",
      [restPr(1, "layer-1", "main"), restPr(2, "layer-2", "layer-1")].join("\n"),
    ],
  ]);
  const { adapter } = adapterFor({
    "layer-2": [
      capture("layer-2", [
        { turn: 0, at: "2024-01-02T00:00:00.000Z", prompt: "only this one" },
      ]),
    ],
  });

  const stack = await captureStack("acme/widgets", 2, { adapter, exec });

  assert.deepEqual(
    stack.layers.map((layer) => layer.pr),
    [2],
  );
});

test("no adapter means no capture, and no repeated probing per layer", async () => {
  // `??` does not short-circuit on an explicit null, so a missing adapter used
  // to be re-detected once for every layer in the stack.
  const { exec } = runner([
    ["api graphql", noStack(2, "layer-2", "layer-1")],
    [
      "repos/acme/widgets/pulls",
      [
        restPr(1, "layer-1", "main"),
        restPr(2, "layer-2", "layer-1"),
        restPr(3, "layer-3", "layer-2"),
      ].join("\n"),
    ],
  ]);
  const probe = adapterFor({}, { available: false });

  const stack = await captureStack("acme/widgets", 2, {
    adapters: [probe.adapter],
    exec,
  });

  assert.deepEqual(stack.layers, []);
  // Three layers, but detection must happen exactly once.
  assert.equal(probe.probes, 1);
});
