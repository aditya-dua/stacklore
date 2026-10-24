/**
 * Capture orchestration: join a pull request layer to its recorded session,
 * redact, distill, and build a storable record.
 */

import { resolveAdapter, type CaptureAdapter } from "./adapters/index.js";
import { distillIntent } from "./distill.js";
import { redact, redactAll } from "./redact.js";
import { getStack, type PullRequestInfo } from "./stack.js";
import {
  SCHEMA_VERSION,
  type Exchange,
  type LoreRecord,
  type LoreStack,
  type RedactionReport,
} from "./types.js";

export interface CaptureOptions {
  repo: string;
  adapter?: CaptureAdapter | null;
  adapterName?: string;
  includeResponses?: boolean;
}

function mergeReports(reports: RedactionReport[]): RedactionReport {
  const rules = new Set<string>();
  let count = 0;
  for (const report of reports) {
    count += report.count;
    for (const rule of report.rules) rules.add(rule);
  }
  return { count, rules: [...rules].sort() };
}

/** Build a lore record for one pull request layer, or null if nothing captured. */
export async function captureLayer(
  pr: PullRequestInfo,
  options: CaptureOptions,
): Promise<LoreRecord | null> {
  const adapter =
    options.adapter ?? (await resolveAdapter(undefined, options.adapterName));
  if (!adapter) return null;

  const captures = await adapter.capture({
    branch: pr.branch,
    repo: options.repo,
    includeResponses: options.includeResponses ?? false,
  });
  if (captures.length === 0) return null;

  // A branch may have been worked across several sessions; keep them all,
  // ordered so the transcript reads chronologically.
  const exchanges: Exchange[] = [];
  const files = new Set<string>();
  const reports: RedactionReport[] = [];

  for (const capture of captures) {
    for (const exchange of capture.exchanges) {
      const prompt = redact(exchange.prompt);
      reports.push(prompt.report);

      const entry: Exchange = {
        turn: exchange.turn,
        at: exchange.at,
        prompt: prompt.text,
      };

      if (exchange.response !== undefined) {
        const response = redact(exchange.response);
        reports.push(response.report);
        entry.response = response.text;
      }

      exchanges.push(entry);
    }
    for (const file of capture.files) files.add(file);
  }

  exchanges.sort((a, b) => a.turn - b.turn || a.at.localeCompare(b.at));

  const primary = captures[0];
  const summary = primary?.summary ?? null;
  const safeSummary = summary ? redact(summary) : null;
  if (safeSummary) reports.push(safeSummary.report);

  // File paths can embed secrets in rare cases; redact them too.
  const safeFiles = redactAll([...files].sort());
  reports.push(safeFiles.report);

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: options.repo,
    pr: pr.number,
    branch: pr.branch,
    title: pr.title,
    stack: pr.stack,
    capturedAt: new Date().toISOString(),
    source: {
      tool: primary?.tool ?? adapter.name,
      adapter: adapter.name,
      sessionId: primary?.sessionId ?? "",
    },
    intent: distillIntent(exchanges, safeSummary?.text ?? null),
    exchanges,
    files: safeFiles.texts,
    redactions: mergeReports(reports),
  };
}

/** Capture every layer of the stack containing `pr`. */
export async function captureStack(
  repo: string,
  pr: number,
  options: Omit<CaptureOptions, "repo"> = {},
): Promise<LoreStack> {
  const members = await getStack(repo, pr);
  const adapter =
    options.adapter ?? (await resolveAdapter(undefined, options.adapterName));

  const layers: LoreRecord[] = [];
  for (const member of members) {
    const record = await captureLayer(member, { ...options, repo, adapter });
    if (record) layers.push(record);
  }

  const head = members.find((m) => m.number === pr) ?? members[0];

  return {
    repo,
    stackNumber: head?.stack.number ?? null,
    base: head?.stack.base ?? head?.baseBranch ?? null,
    layers,
  };
}
