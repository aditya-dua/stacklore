/**
 * stacklore — preserve the prompts and intent behind every layer of a stacked
 * pull request, in a private store.
 */

export * from "./types.js";
export * from "./redact.js";
export * from "./distill.js";
export * from "./config.js";
export { LoreStore, StoreError, type StoreOptions } from "./store.js";
export {
  GitHubError,
  currentBranch,
  currentRepo,
  getPullRequest,
  getStack,
  pullRequestForBranch,
  upsertComment,
  type PullRequestInfo,
} from "./stack.js";
export {
  CopilotAdapter,
  defaultAdapters,
  resolveAdapter,
  type CaptureAdapter,
  type CaptureQuery,
  type CaptureResult,
} from "./adapters/index.js";
export { captureLayer, captureStack, type CaptureOptions } from "./capture.js";
