/**
 * stacklore — preserve the prompts and intent behind every layer of a stacked
 * pull request, in a private store.
 */

export * from "./types.ts";
export * from "./redact.ts";
export * from "./distill.ts";
export * from "./config.ts";
export {
  CommandError,
  runCommand,
  type CommandRunner,
  type RunOptions,
} from "./exec.ts";
export { LoreStore, StoreError, type StoreOptions } from "./store.ts";
export {
  GitHubError,
  currentBranch,
  currentRepo,
  getPullRequest,
  getStack,
  pullRequestForBranch,
  upsertComment,
  type PullRequestInfo,
} from "./stack.ts";
export {
  CopilotAdapter,
  defaultAdapters,
  resolveAdapter,
  type CaptureAdapter,
  type CaptureQuery,
  type CaptureResult,
} from "./adapters/index.ts";
export { captureLayer, captureStack, type CaptureOptions } from "./capture.ts";
export {
  EXTENSION_NAME,
  extensionDir,
  extensionInstalled,
  installExtension,
  shimScript,
  uninstallExtension,
  type ExtensionOptions,
  type InstallResult,
} from "./extension.ts";
