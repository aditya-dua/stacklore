export type {
  CaptureAdapter,
  CaptureQuery,
  CaptureResult,
} from "./types.js";
export { CopilotAdapter } from "./copilot.js";

import type { CaptureAdapter } from "./types.js";
import { CopilotAdapter } from "./copilot.js";

/** Adapters tried in order when none is explicitly selected. */
export function defaultAdapters(): CaptureAdapter[] {
  return [new CopilotAdapter()];
}

/** First adapter that can run on this machine, or null. */
export async function resolveAdapter(
  adapters: CaptureAdapter[] = defaultAdapters(),
  name?: string,
): Promise<CaptureAdapter | null> {
  const candidates = name
    ? adapters.filter((a) => a.name === name)
    : adapters;
  for (const adapter of candidates) {
    if (await adapter.isAvailable()) return adapter;
  }
  return null;
}
