/**
 * Secret redaction.
 *
 * A private store shrinks the blast radius of a leaked credential but does not
 * remove it: collaborators on the store still see it, and a leaked token is
 * live wherever it is written. Redaction therefore runs unconditionally, before
 * anything is persisted.
 */

import type { RedactionReport } from "./types.ts";

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Replacement label shown in place of the secret. */
  label: string;
}

/**
 * Ordered redaction rules. More specific patterns run first so that a token is
 * labelled by its true provider rather than by a generic assignment rule.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    label: "PRIVATE_KEY",
  },
  {
    name: "github-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    label: "GITHUB_PAT",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    label: "GITHUB_TOKEN",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    label: "AWS_ACCESS_KEY",
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    label: "ANTHROPIC_KEY",
  },
  {
    // `sk-ant-` is excluded so Anthropic keys keep their own, more specific label.
    name: "openai-key",
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    label: "OPENAI_KEY",
  },
  {
    name: "slack-token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    label: "SLACK_TOKEN",
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    label: "GOOGLE_API_KEY",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    label: "JWT",
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    label: "URL_CREDENTIALS",
  },
  {
    name: "bearer-token",
    pattern: /\b(?:Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    label: "BEARER_TOKEN",
  },
  {
    // The negative lookahead stops this generic rule from re-redacting a value
    // a more specific rule already replaced, which would lose the provider
    // label and double-count the redaction.
    name: "assigned-secret",
    pattern:
      /\b((?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?token|client[_-]?secret)\s*[:=]\s*)(?!\[REDACTED:)(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s,;"'`]{6,})/gi,
    label: "SECRET",
  },
];

export interface RedactionResult {
  text: string;
  report: RedactionReport;
}

/**
 * Redact secrets from a single string.
 *
 * Rules that preserve a prefix (such as `api_key=`) keep that prefix so the
 * surrounding prose stays readable while the value is destroyed.
 */
export function redact(
  input: string,
  rules: RedactionRule[] = DEFAULT_RULES,
): RedactionResult {
  if (!input) {
    return { text: input, report: { count: 0, rules: [] } };
  }

  let text = input;
  let count = 0;
  const fired = new Set<string>();

  for (const rule of rules) {
    // Rules are module-level and carry the /g flag, so reset state per use.
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args) => {
      count += 1;
      fired.add(rule.name);
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return `${prefix}[REDACTED:${rule.label}]`;
    });
  }

  return { text, report: { count, rules: [...fired].sort() } };
}

/** Redact many strings, returning a combined report. */
export function redactAll(
  inputs: string[],
  rules: RedactionRule[] = DEFAULT_RULES,
): { texts: string[]; report: RedactionReport } {
  const texts: string[] = [];
  let count = 0;
  const fired = new Set<string>();

  for (const input of inputs) {
    const result = redact(input, rules);
    texts.push(result.text);
    count += result.report.count;
    for (const name of result.report.rules) fired.add(name);
  }

  return { texts, report: { count, rules: [...fired].sort() } };
}

/** True when the text still contains anything matching a redaction rule. */
export function hasSecrets(
  input: string,
  rules: RedactionRule[] = DEFAULT_RULES,
): boolean {
  return redact(input, rules).report.count > 0;
}
