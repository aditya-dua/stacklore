import assert from "node:assert/strict";
import { test } from "node:test";

import {
  distillIntent,
  meaningfulExchanges,
  renderStackComment,
} from "../src/distill.ts";
import { recordPath, SCHEMA_VERSION } from "../src/types.ts";
import type { Exchange, LoreRecord, LoreStack } from "../src/types.ts";

function exchange(turn: number, prompt: string): Exchange {
  return { turn, at: `2026-10-24T10:0${turn}:00Z`, prompt };
}

function record(pr: number, overrides: Partial<LoreRecord> = {}): LoreRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: "acme/widgets",
    pr,
    branch: `layer-${pr}`,
    title: `Layer ${pr}`,
    stack: { number: 7, position: pr, size: 3, base: "main" },
    capturedAt: "2026-10-24T10:00:00Z",
    source: { tool: "copilot", adapter: "copilot", sessionId: "s1" },
    intent: `Intent for ${pr}`,
    exchanges: [exchange(0, "Do the thing properly please")],
    files: [],
    redactions: { count: 0, rules: [] },
    ...overrides,
  };
}

test("record paths are keyed by PR, never by SHA", () => {
  assert.equal(
    recordPath("acme/widgets", 42),
    "records/acme/widgets/pr-42.json",
  );
});

test("filters out low-signal acknowledgements", () => {
  const kept = meaningfulExchanges([
    exchange(0, "Add retry logic to the webhook consumer"),
    exchange(1, "ok"),
    exchange(2, "thanks!"),
    exchange(3, "yes"),
    exchange(4, "Now make the backoff exponential and cap it at 30s"),
  ]);
  assert.equal(kept.length, 2);
  assert.ok(kept[0]?.prompt.includes("retry logic"));
  assert.ok(kept[1]?.prompt.includes("exponential"));
});

test("prefers the tool summary when deriving intent", () => {
  const intent = distillIntent(
    [exchange(0, "Something vague to start with here")],
    "Add exponential backoff to the webhook consumer. Also tidy logs.",
  );
  assert.equal(
    intent,
    "Add exponential backoff to the webhook consumer.",
  );
});

test("falls back to the first meaningful prompt", () => {
  const intent = distillIntent([
    exchange(0, "hmm"),
    exchange(1, "Rework the parser so it keys on PR number. Then add tests."),
  ]);
  assert.equal(intent, "Rework the parser so it keys on PR number.");
});

test("strips code fences from derived intent", () => {
  const intent = distillIntent([
    exchange(0, "Fix this bug:\n```js\nconst x = 1;\n```\nIt crashes on null."),
  ]);
  assert.ok(!intent.includes("const x"));
});

test("reports absence of intent rather than throwing", () => {
  assert.equal(distillIntent([]), "No recorded intent.");
});

test("renders layers top-down with the current PR marked", () => {
  const stack: LoreStack = {
    repo: "acme/widgets",
    stackNumber: 7,
    base: "main",
    layers: [record(1), record(2), record(3)],
  };
  const body = renderStackComment(stack, { current: 2 });
  const lines = body.split("\n").filter((l) => l.startsWith("|"));

  // Header, separator, then layers ordered 3, 2, 1.
  assert.ok(lines[2]?.includes("#3"));
  assert.ok(lines[3]?.includes("#2"));
  assert.ok(lines[4]?.includes("#1"));
  assert.ok(lines[3]?.includes("👉"), "current layer should be marked");
});

test("comment never embeds transcripts, only a private link", () => {
  const stack: LoreStack = {
    repo: "acme/widgets",
    stackNumber: 7,
    base: "main",
    layers: [
      record(1, {
        exchanges: [exchange(0, "A very sensitive internal prompt body")],
      }),
    ],
  };
  const body = renderStackComment(stack, {
    storeUrl: "https://github.com/acme/lore/blob/HEAD/records/acme/widgets/pr-1.json",
  });
  assert.ok(!body.includes("A very sensitive internal prompt body"));
  assert.ok(body.includes("Full transcripts"));
  assert.ok(body.includes("private store"));
});

test("escapes pipes so intent cannot break the table", () => {
  const stack: LoreStack = {
    repo: "acme/widgets",
    stackNumber: null,
    base: "main",
    layers: [record(1, { intent: "Handle a | b | c cases" })],
  };
  const body = renderStackComment(stack);
  assert.ok(body.includes("a \\| b \\| c"));
});

test("surfaces redaction counts to reviewers", () => {
  const stack: LoreStack = {
    repo: "acme/widgets",
    stackNumber: 7,
    base: "main",
    layers: [record(1, { redactions: { count: 3, rules: ["github-token"] } })],
  };
  assert.ok(renderStackComment(stack).includes("3 secrets redacted"));
});

test("handles an empty stack without throwing", () => {
  const body = renderStackComment({
    repo: "acme/widgets",
    stackNumber: null,
    base: null,
    layers: [],
  });
  assert.ok(body.includes("No lore captured"));
});
