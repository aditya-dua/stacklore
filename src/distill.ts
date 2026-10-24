/**
 * Distillation and rendering.
 *
 * Raw transcripts are mostly noise. The value of a lore record is the intent
 * behind a layer, so prompts are condensed into a short statement of why the
 * change exists and rendered as a compact, reviewer-facing summary.
 */

import type { Exchange, LoreRecord, LoreStack } from "./types.js";

/** Conversational filler that carries no intent. */
const LOW_SIGNAL =
  /^(ok(ay)?|thanks|thank you|yes|no|yep|nope|sure|go ahead|continue|proceed|do it|lgtm|nice|great|perfect|cool|got it|sounds good|please|try again|retry|fix it|hmm+)\W*$/i;

/** Prompts worth keeping: drops acknowledgements and bare confirmations. */
export function meaningfulExchanges(exchanges: Exchange[]): Exchange[] {
  return exchanges.filter((e) => {
    const text = e.prompt.trim();
    if (text.length < 12) return false;
    if (LOW_SIGNAL.test(text)) return false;
    return true;
  });
}

function firstSentence(text: string, max = 220): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const match = cleaned.match(/^.{20,}?[.!?](?=\s|$)/);
  const candidate = (match?.[0] ?? cleaned).trim();
  return candidate.length > max
    ? `${candidate.slice(0, max - 1).trimEnd()}…`
    : candidate;
}

/**
 * Derive a one-line intent for a layer.
 *
 * The tool's own session summary is preferred when present, because it already
 * reflects the whole session; the opening prompt is the fallback since it
 * states the original ask before any course corrections.
 */
export function distillIntent(
  exchanges: Exchange[],
  summary?: string | null,
): string {
  if (summary?.trim()) return firstSentence(summary);
  const meaningful = meaningfulExchanges(exchanges);
  const seed = meaningful[0] ?? exchanges[0];
  return seed ? firstSentence(seed.prompt) : "No recorded intent.";
}

export interface RenderOptions {
  /** Link to the private store, shown instead of transcript contents. */
  storeUrl?: string;
  /** Pull request currently being rendered, highlighted in the table. */
  current?: number;
}

/**
 * Render a stack's lore as a pull request comment.
 *
 * Only distilled intent is published. Transcripts stay in the private store and
 * are referenced by a link, which simply 404s for anyone without access.
 */
export function renderStackComment(
  stack: LoreStack,
  options: RenderOptions = {},
): string {
  const lines: string[] = ["## 🪶 Stack lore", ""];

  if (stack.layers.length === 0) {
    lines.push("_No lore captured for this stack yet._");
    return lines.join("\n");
  }

  lines.push(
    `Context behind each layer of this stack${
      stack.base ? `, based on \`${stack.base}\`` : ""
    }.`,
    "",
    "| | PR | Layer | Intent |",
    "|---|---|---|---|",
  );

  for (const layer of [...stack.layers].reverse()) {
    const marker = layer.pr === options.current ? "👉" : "";
    const position =
      layer.stack.position && layer.stack.size
        ? `${layer.stack.position}/${layer.stack.size}`
        : "—";
    const intent = layer.intent.replace(/\|/g, "\\|");
    lines.push(`| ${marker} | #${layer.pr} | ${position} | ${intent} |`);
  }

  const totalPrompts = stack.layers.reduce(
    (sum, l) => sum + l.exchanges.length,
    0,
  );
  const totalRedactions = stack.layers.reduce(
    (sum, l) => sum + l.redactions.count,
    0,
  );

  lines.push(
    "",
    `${totalPrompts} prompt${totalPrompts === 1 ? "" : "s"} captured across ${
      stack.layers.length
    } layer${stack.layers.length === 1 ? "" : "s"}.`,
  );

  if (totalRedactions > 0) {
    lines.push(
      `${totalRedactions} secret${
        totalRedactions === 1 ? "" : "s"
      } redacted before storage.`,
    );
  }

  if (options.storeUrl) {
    lines.push("", `🔒 [Full transcripts](${options.storeUrl}) — private store.`);
  }

  return lines.join("\n");
}

/** Render a single record for terminal output. */
export function renderRecord(record: LoreRecord): string {
  const lines = [
    `PR #${record.pr} — ${record.title}`,
    `branch   ${record.branch}`,
    `stack    ${
      record.stack.position && record.stack.size
        ? `layer ${record.stack.position} of ${record.stack.size}`
        : "not stacked"
    }`,
    `captured ${record.capturedAt} via ${record.source.tool}`,
    `intent   ${record.intent}`,
    "",
    `Prompts (${record.exchanges.length}):`,
  ];

  for (const exchange of record.exchanges) {
    const text = exchange.prompt.replace(/\s+/g, " ").trim();
    const clipped = text.length > 160 ? `${text.slice(0, 159)}…` : text;
    lines.push(`  ${String(exchange.turn).padStart(3)}. ${clipped}`);
  }

  if (record.redactions.count > 0) {
    lines.push(
      "",
      `Redacted ${record.redactions.count} secret(s): ${record.redactions.rules.join(", ")}`,
    );
  }

  return lines.join("\n");
}
