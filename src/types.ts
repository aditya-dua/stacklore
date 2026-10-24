/**
 * Core types for stacklore.
 *
 * Design note: records are keyed by `repo + pr number`, never by commit SHA.
 * Stacked pull requests are cascade-rebased server-side and may be squashed on
 * merge, so any SHA-keyed store would orphan itself. PR numbers are stable for
 * the life of the pull request.
 */

export const SCHEMA_VERSION = 1 as const;

/** A pull request's position within a GitHub stack. */
export interface StackPosition {
  /** Stack identifier, when the PR belongs to a stack. */
  number: number | null;
  /** 1-based position from the bottom of the stack. */
  position: number | null;
  /** Total number of pull requests in the stack. */
  size: number | null;
  /** The stack's trunk branch, e.g. `main`. */
  base: string | null;
}

/** A single captured prompt/response exchange. */
export interface Exchange {
  turn: number;
  at: string;
  /** The human's prompt. Always redacted before persistence. */
  prompt: string;
  /** Optional assistant summary. Omitted unless `--full` capture is requested. */
  response?: string;
}

/** Where a record was captured from. */
export interface CaptureSource {
  /** Agent tool, e.g. `copilot`, `claude-code`, `cursor`. */
  tool: string;
  /** Adapter that produced the record. */
  adapter: string;
  /** Opaque session identifier from the source tool. */
  sessionId: string;
}

/** Redaction accounting, so reviewers know something was removed. */
export interface RedactionReport {
  count: number;
  /** Names of rules that fired, e.g. `github-token`. Never the matched values. */
  rules: string[];
}

/** One layer of lore: the context behind a single pull request in a stack. */
export interface LoreRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  /** `owner/repo` of the source repository. */
  repo: string;
  /** Pull request number. Stable across rebases. */
  pr: number;
  branch: string;
  title: string;
  stack: StackPosition;
  capturedAt: string;
  source: CaptureSource;
  /** Distilled statement of why this layer exists. */
  intent: string;
  exchanges: Exchange[];
  /** Repo-relative paths touched during the session. */
  files: string[];
  redactions: RedactionReport;
}

/** A full stack's worth of lore, ordered bottom-to-top. */
export interface LoreStack {
  repo: string;
  stackNumber: number | null;
  base: string | null;
  layers: LoreRecord[];
}

/** Storage path for a record inside the private store repository. */
export function recordPath(repo: string, pr: number): string {
  return `records/${repo}/pr-${pr}.json`;
}
