# stacklore

> Preserve the prompts and intent behind every layer of a stacked pull request — in a private store.

AI writes most of the code now. The reasoning that produced it — the prompts, the
corrections, the rejected approaches — lives in a chat window and is gone by the
next morning. The diff survives; the *why* does not.

`stacklore` captures that context and binds it to the structure code review
already uses: the pull request stack.

```
main
 └── #41  Extract the rate limiter        ← "why a token bucket, not a sliding window?"
      └── #42  Add Redis backing          ← "why Redis over in-process state?"
           └── #43  Wire up the consumer  ← "why fail open on Redis timeout?"
```

Each layer keeps its own lore. Reviewers see the intent inline; the full
transcripts stay private.

## Why a separate private repository

GitHub visibility is **per-repository**. There are no per-ref, per-branch, or
per-pull-request ACLs — so a sidecar ref such as `refs/stacklore/*` inside the
source repository would be readable by anyone who can read that repository.

Records therefore live in a separate **private** store repository. The public
pull request receives only a distilled one-line intent plus a link that simply
404s for anyone without access.

A private store shrinks the blast radius of a leaked credential; it does not
remove it. Redaction runs unconditionally before anything is written.

## Install

```bash
npm install -g stacklore
```

Requires Node 20+, `git`, `sqlite3`, and an authenticated [`gh`](https://cli.github.com)
CLI. `stacklore` reuses your existing `gh` credentials rather than asking for a
second token.

### As a `gh` extension

```bash
stacklore gh-install    # then: gh stacklore save
```

This registers `gh stacklore` for your user. `gh extension install` is not used
because it requires the *repository* to be named `gh-stacklore`, and this one is
named `stacklore`; `gh-install` sidesteps that by writing the extension shim
itself, so it works for a global npm install or a source checkout alike. Re-run
it after upgrading Node or stacklore, and `stacklore gh-uninstall` to remove it.
A companion `gh-stacklore` repository, for the usual `gh extension install`
flow, is a planned follow-up; the `gh-stacklore` script at the root of this
repository is its entry point.

## Quick start

```bash
cd your-repo

# Create the private store and write .stacklore.json
stacklore init your-org/your-repo-lore

# On any branch in a stack, capture the whole stack
stacklore save

# Read it back
stacklore show --pr 42
stacklore list
```

`.stacklore.json` is safe to commit — it names the store, it does not expose its
contents.

## Commands

| Command | Description |
|---|---|
| `stacklore init <store-repo>` | Create the private store and write config |
| `stacklore save [--pr N]` | Capture the stack's prompts into the store |
| `stacklore show [--pr N]` | Print stored lore for a pull request |
| `stacklore list` | List captured records for this repository |
| `stacklore status` | Show config, adapter availability, and stack position |
| `stacklore gh-install` | Register the CLI as a `gh stacklore` extension |
| `stacklore gh-uninstall` | Remove the `gh stacklore` extension |

| Flag | Description |
|---|---|
| `--pr <number>` | Target pull request. Defaults to the current branch's PR |
| `--full` | Persist assistant responses as well as prompts |
| `--no-comment` | Do not post or update the pull request comment |
| `--dry-run` | Capture and print without writing or pushing |
| `--json` | Emit JSON instead of formatted text |

## How it works

1. **Resolve the stack.** Stacks are read from GraphQL — `PullRequest.stackEntry`
   yields the stack's number, size, trunk, and every member's position in one
   round-trip. The REST pull request resource does *not* expose a `stack` field,
   so GraphQL is the only source. When GitHub reports no native stack, the
   topology is inferred by walking the chain of base branches (see below).
   Standalone pull requests are treated as a stack of one.
2. **Capture per layer.** Each layer is a branch, so the adapter joins on
   `branch` to find the sessions recorded against it.
3. **Redact.** Every prompt passes through the redaction engine before it is
   persisted. The report names the *rules* that fired, never the matched values.
4. **Distill.** Acknowledgements and filler are dropped; a one-line intent is
   derived from the session summary or the opening prompt.
5. **Store and link.** Records are written to the private store and the pull
   request gets a single updated comment with intent plus a private link.

### Keyed by pull request, never by SHA

Stacks are cascade-rebased server-side and may be squashed on merge, so every
commit SHA in a stack is unstable. Records are keyed by `repo + pr number`,
which survives rebases, force-pushes, and squash merges:

```
records/<owner>/<repo>/pr-<number>.json
```

### Native stacks and inferred chains

GitHub only reports a native stack for pull requests created through its
stacking flow. A stack assembled by hand — each pull request targeting the one
below it — has a null `stackEntry`, so stacklore reconstructs the chain itself:
it walks base-to-head links from the trunk and stops at any branch point, since
a tree is not a stack. Inferred layers are marked `source: "inferred"` in the
record and labelled as such in `stacklore status`.

### Idempotence

`save` is safe to re-run. `capturedAt` moves on every capture, so records are
compared ignoring that field; an unchanged layer is not rewritten and the store
does not accumulate empty commits. The pull request comment is matched by a
hidden marker and updated in place rather than duplicated.

## Redaction

Secrets are removed before anything reaches the store:

| Rule | Covers |
|---|---|
| `private-key` | PEM blocks (RSA, EC, DSA, OpenSSH, PGP) |
| `github-pat` / `github-token` | `github_pat_…`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` |
| `aws-access-key` | `AKIA`, `ASIA`, `ABIA`, `ACCA` |
| `openai-key` / `anthropic-key` | `sk-…`, `sk-proj-…`, `sk-ant-…` |
| `slack-token` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-` |
| `google-api-key` | `AIza…` |
| `jwt` | Three-segment JWTs |
| `url-credentials` | `https://user:pass@host` |
| `bearer-token` | `Authorization: Bearer …` |
| `assigned-secret` | `api_key=`, `password=`, `token=`, `client_secret=` |

Key names are preserved so prose stays readable — `api_key = "[REDACTED:SECRET]"`
— and a more specific rule always wins over the generic one, so a GitHub token
is labelled `GITHUB_TOKEN` rather than `SECRET`.

Redaction is best-effort pattern matching, not a guarantee. Treat the store as
sensitive and keep it private.

## Supported tools

| Tool | Adapter | Status |
|---|---|---|
| GitHub Copilot | `copilot` | Supported |
| Claude Code | `claude-code` | Planned |
| Cursor | `cursor` | Planned |
| Codex CLI | `codex` | Planned |

The Copilot adapter reads `~/.copilot/session-store.db`. Set
`STACKLORE_COPILOT_DB` to point it elsewhere, which is useful for testing and
for machines that keep Copilot state outside the default location.

### Writing an adapter

Capture is deliberately narrow — given a branch, return the exchanges and files
recorded against it:

```ts
import type { CaptureAdapter, CaptureResult } from "stacklore/adapters";

export class MyToolAdapter implements CaptureAdapter {
  readonly name = "my-tool";

  async isAvailable(): Promise<boolean> {
    return existsSync(myToolSessionPath);
  }

  async capture({ branch }): Promise<CaptureResult[]> {
    return [{
      tool: "my-tool",
      adapter: this.name,
      sessionId: "…",
      branch,
      summary: "…",
      exchanges: [{ turn: 0, at: "2026-10-24T…", prompt: "…" }],
      files: ["src/index.ts"],
    }];
  }
}
```

Redaction and distillation are applied downstream, so adapters return raw data.

## Programmatic use

```ts
import { captureStack, renderStackComment } from "stacklore";

const stack = await captureStack("acme/widgets", 42);
console.log(renderStackComment(stack, { current: 42 }));
```

Every module that shells out takes an optional `exec` runner, so `gh` and `git`
can be substituted in tests or wrapped by a host application:

```ts
await captureStack("acme/widgets", 42, { exec: myRunner });
```

## Status

Early, but the full path is exercised end-to-end against real GitHub resources,
and `gh`/`git` interactions are covered by unit tests with injected runners. The
record schema is versioned (`schemaVersion: 1`) and will migrate rather than
break.

## License

MIT
