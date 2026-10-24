import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RULES, hasSecrets, redact, redactAll } from "../src/redact.ts";

test("redacts GitHub personal access tokens", () => {
  const { text, report } = redact(
    "use github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz0123456789ABCDEF to auth",
  );
  assert.ok(!text.includes("github_pat_11ABCDEFG0"));
  assert.ok(text.includes("[REDACTED:GITHUB_PAT]"));
  assert.equal(report.count, 1);
  assert.deepEqual(report.rules, ["github-pat"]);
});

test("redacts classic gh tokens of every prefix", () => {
  for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
    const token = `${prefix}_${"a1B2c3D4e5F6g7H8".repeat(2)}`;
    const { text, report } = redact(`token=${token}`);
    assert.ok(!text.includes(token), `${prefix} token survived redaction`);
    assert.equal(report.count, 1);
  }
});

test("redacts AWS access keys", () => {
  const { text } = redact("AKIAIOSFODNN7EXAMPLE is the key");
  assert.ok(text.includes("[REDACTED:AWS_ACCESS_KEY]"));
  assert.ok(!text.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redacts OpenAI and Anthropic keys distinctly", () => {
  const openai = redact(`sk-proj-${"x".repeat(32)}`);
  assert.ok(openai.text.includes("[REDACTED:OPENAI_KEY]"));

  const anthropic = redact(`sk-ant-${"y".repeat(32)}`);
  assert.ok(anthropic.text.includes("[REDACTED:ANTHROPIC_KEY]"));
  assert.deepEqual(anthropic.report.rules, ["anthropic-key"]);
});

test("redacts private key blocks entirely", () => {
  const key = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAxGZ1kq9mLnOpQrStUvWxYz0123456789",
    "aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQgbWF0ZXJpYWw=",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text } = redact(`here it is:\n${key}\nthanks`);
  assert.ok(text.includes("[REDACTED:PRIVATE_KEY]"));
  assert.ok(!text.includes("MIIEowIBAAKCAQEA"));
  assert.ok(text.includes("thanks"));
});

test("redacts credentials embedded in URLs", () => {
  const { text } = redact("clone https://admin:hunter2@github.example.com/x.git");
  assert.ok(!text.includes("hunter2"));
  assert.ok(text.includes("[REDACTED:URL_CREDENTIALS]"));
});

test("preserves the key name when redacting an assignment", () => {
  const { text } = redact('api_key = "super-secret-value-here"');
  assert.ok(text.includes("api_key"), "key name should survive for readability");
  assert.ok(!text.includes("super-secret-value-here"));
  assert.ok(text.includes("[REDACTED:SECRET]"));
});

test("redacts JWTs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const { text } = redact(`Authorization header: ${jwt}`);
  assert.ok(!text.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  assert.ok(text.includes("[REDACTED:JWT]"));
});

test("leaves ordinary prose untouched", () => {
  const prose =
    "Refactor the stack walker so it keys records by PR number instead of SHA.";
  const { text, report } = redact(prose);
  assert.equal(text, prose);
  assert.equal(report.count, 0);
  assert.deepEqual(report.rules, []);
});

test("does not flag words that merely resemble tokens", () => {
  const prose = "The skeleton key pattern and ghost branches are unrelated.";
  assert.equal(redact(prose).report.count, 0);
});

test("handles multiple secrets of different kinds in one string", () => {
  const input = `export AWS_KEY=AKIAIOSFODNN7EXAMPLE\nexport GH=ghp_${"z".repeat(24)}`;
  const { text, report } = redact(input);
  assert.ok(report.count >= 2);
  assert.ok(report.rules.includes("aws-access-key"));
  assert.ok(report.rules.includes("github-token"));
  assert.ok(!text.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redactAll aggregates across inputs", () => {
  const { texts, report } = redactAll([
    "clean text here, nothing to see",
    "AKIAIOSFODNN7EXAMPLE",
  ]);
  assert.equal(texts.length, 2);
  assert.equal(texts[0], "clean text here, nothing to see");
  assert.equal(report.count, 1);
  assert.deepEqual(report.rules, ["aws-access-key"]);
});

test("global regex state does not leak between calls", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  for (let i = 0; i < 5; i += 1) {
    const { report } = redact(`attempt ${i}: ${secret}`);
    assert.equal(report.count, 1, `call ${i} missed the secret`);
  }
});

test("hasSecrets reports presence without exposing values", () => {
  assert.equal(hasSecrets("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(hasSecrets("just a normal sentence"), false);
});

test("reports never contain the matched secret", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const { report } = redact(secret);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test("empty input is handled safely", () => {
  const { text, report } = redact("");
  assert.equal(text, "");
  assert.equal(report.count, 0);
});

test("every rule has a unique name and global flag", () => {
  const names = new Set<string>();
  for (const rule of DEFAULT_RULES) {
    assert.ok(!names.has(rule.name), `duplicate rule name: ${rule.name}`);
    names.add(rule.name);
    assert.ok(rule.pattern.global, `rule ${rule.name} must use /g`);
  }
});
