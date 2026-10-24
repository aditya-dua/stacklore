/**
 * Capture adapter contract.
 *
 * Every agent tool persists its sessions differently, so stacklore keeps the
 * capture surface narrow: given a branch, return the exchanges and touched
 * files recorded while working on it. Implement this interface to add support
 * for a new tool.
 */

import type { Exchange } from "../types.js";

/** Raw, un-redacted capture for a single branch. Redaction happens downstream. */
export interface CaptureResult {
  tool: string;
  adapter: string;
  sessionId: string;
  branch: string;
  /** Short human summary of the session, when the tool records one. */
  summary: string | null;
  exchanges: Exchange[];
  files: string[];
}

export interface CaptureQuery {
  /** Branch backing the pull request layer. */
  branch: string;
  /** `owner/repo`, used to disambiguate same-named branches across repos. */
  repo?: string;
  /** Include assistant responses, not just human prompts. */
  includeResponses?: boolean;
}

export interface CaptureAdapter {
  /** Stable adapter id, e.g. `copilot`. */
  readonly name: string;
  /** Whether this adapter can run on the current machine. */
  isAvailable(): Promise<boolean>;
  /** Return captures for a branch, newest session first. Empty when none found. */
  capture(query: CaptureQuery): Promise<CaptureResult[]>;
}
