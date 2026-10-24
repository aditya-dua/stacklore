#!/usr/bin/env node
/**
 * stacklore CLI.
 *
 * Usable standalone or as a GitHub CLI extension (`gh stacklore ...`) when
 * installed as `gh-stacklore`.
 */

import { captureStack } from "./capture.ts";
import { loadConfig, saveConfig, type StackloreConfig } from "./config.ts";
import { renderRecord, renderStackComment } from "./distill.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { LoreStore } from "./store.ts";
import {
  EXTENSION_NAME,
  extensionInstalled,
  installExtension,
  uninstallExtension,
} from "./extension.ts";
import {
  currentBranch,
  currentRepo,
  getStack,
  pullRequestForBranch,
  upsertComment,
} from "./stack.ts";
import type { LoreStack } from "./types.ts";

const COMMENT_MARKER = "<!-- stacklore -->";

const USAGE = `stacklore — preserve the prompts behind every layer of a stacked PR

Usage
  stacklore init <store-repo>   Create and wire up the private store
  stacklore save [--pr N]       Capture the stack's prompts into the store
  stacklore show [--pr N]       Print stored lore for a pull request
  stacklore list                List captured records for this repo
  stacklore status              Show configuration and adapter availability
  stacklore gh-install          Install as a 'gh stacklore' extension
  stacklore gh-uninstall        Remove the 'gh stacklore' extension

Options
  --pr <number>     Target pull request. Defaults to the current branch's PR.
  --full            Persist assistant responses as well as prompts.
  --no-comment      Do not post or update the pull request comment.
  --dry-run         Capture and print without writing or pushing.
  --json            Emit JSON instead of formatted text.
`;

interface Args {
  command: string;
  pr?: number;
  full: boolean;
  comment: boolean;
  dryRun: boolean;
  json: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "help",
    full: false,
    comment: true,
    dryRun: false,
    json: false,
    positional: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--pr": {
        const value = argv[i + 1];
        if (!value) throw new Error("--pr requires a number");
        args.pr = Number.parseInt(value, 10);
        i += 1;
        break;
      }
      case "--full":
        args.full = true;
        break;
      case "--no-comment":
        args.comment = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        if (arg && !arg.startsWith("-")) args.positional.push(arg);
    }
  }

  return args;
}

function fail(message: string): never {
  console.error(`stacklore: ${message}`);
  process.exit(1);
}

async function requireConfig(): Promise<StackloreConfig> {
  const config = await loadConfig();
  if (!config) {
    fail("no .stacklore.json found. Run 'stacklore init <store-repo>' first.");
  }
  return config;
}

/** Resolve the target PR: explicit flag, else the current branch's PR. */
async function resolvePr(repo: string, explicit?: number): Promise<number> {
  if (explicit) return explicit;
  const branch = await currentBranch();
  if (!branch) fail("could not determine the current branch.");
  const pr = await pullRequestForBranch(repo, branch);
  if (!pr) fail(`no open pull request found for branch '${branch}'.`);
  return pr;
}

async function cmdInit(args: Args): Promise<void> {
  const store = args.positional[0];
  if (!store) fail("usage: stacklore init <owner/store-repo>");
  if (!/^[^/]+\/[^/]+$/.test(store)) {
    fail(`store must be in 'owner/repo' form, got '${store}'`);
  }

  const created = await LoreStore.create(store);
  console.log(
    created
      ? `Created private store ${store}`
      : `Store ${store} already exists — reusing it`,
  );

  const config: StackloreConfig = {
    store,
    includeResponses: false,
    comment: true,
  };
  const path = await saveConfig(config);

  console.log(`Wrote ${path}`);
  console.log(`\nStore is private. Commit .stacklore.json — it names the store,`);
  console.log(`it does not expose its contents.`);
}

async function cmdSave(args: Args): Promise<void> {
  const config = await requireConfig();
  const repo = await currentRepo();
  const pr = await resolvePr(repo, args.pr);

  const adapter = await resolveAdapter(undefined, config.adapter);
  if (!adapter) {
    fail("no capture adapter available on this machine.");
  }

  console.log(`Capturing stack for ${repo}#${pr} via ${adapter.name}…`);

  const stack = await captureStack(repo, pr, {
    adapter,
    includeResponses: args.full || config.includeResponses === true,
  });

  if (stack.layers.length === 0) {
    console.log("No sessions matched any branch in this stack. Nothing saved.");
    return;
  }

  const redacted = stack.layers.reduce((n, l) => n + l.redactions.count, 0);
  for (const layer of stack.layers) {
    console.log(
      `  #${layer.pr} ${layer.branch} — ${layer.exchanges.length} prompt(s)`,
    );
  }
  if (redacted > 0) console.log(`  redacted ${redacted} secret(s)`);

  if (args.dryRun) {
    console.log("\n--dry-run: nothing written.");
    if (args.json) console.log(JSON.stringify(stack, null, 2));
    return;
  }

  const store = new LoreStore({ repo: config.store });
  await store.sync();
  for (const layer of stack.layers) await store.write(layer);

  const pushed = await store.commit(
    `lore: ${repo}#${pr} (${stack.layers.length} layer(s))`,
  );
  console.log(pushed ? `Pushed to ${config.store}` : "Store already up to date");

  if (args.comment && config.comment !== false) {
    await postComment(repo, pr, stack, store);
    console.log(`Updated lore comment on ${repo}#${pr}`);
  }
}

async function postComment(
  repo: string,
  pr: number,
  stack: LoreStack,
  store: LoreStore,
): Promise<void> {
  const body = renderStackComment(stack, {
    storeUrl: store.recordUrl(repo, pr),
    current: pr,
  });
  await upsertComment(repo, pr, body, COMMENT_MARKER);
}

async function cmdShow(args: Args): Promise<void> {
  const config = await requireConfig();
  const repo = await currentRepo();
  const pr = await resolvePr(repo, args.pr);

  const store = new LoreStore({ repo: config.store });
  await store.sync();
  const record = await store.read(repo, pr);

  if (!record) {
    console.log(`No lore stored for ${repo}#${pr}. Run 'stacklore save'.`);
    return;
  }

  console.log(args.json ? JSON.stringify(record, null, 2) : renderRecord(record));
}

async function cmdList(args: Args): Promise<void> {
  const config = await requireConfig();
  const repo = await currentRepo();

  const store = new LoreStore({ repo: config.store });
  await store.sync();
  const records = await store.list(repo);

  if (args.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(`No lore stored for ${repo}.`);
    return;
  }

  for (const record of records) {
    const position =
      record.stack.position && record.stack.size
        ? `${record.stack.position}/${record.stack.size}`
        : "—";
    console.log(
      `#${String(record.pr).padEnd(5)} ${position.padEnd(5)} ${record.intent}`,
    );
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const adapter = await resolveAdapter(undefined, config?.adapter);

  console.log(`config   ${config ? "found" : "missing (.stacklore.json)"}`);
  console.log(`store    ${config?.store ?? "—"}`);
  console.log(`adapter  ${adapter ? `${adapter.name} (available)` : "none available"}`);
  console.log(
    `gh ext   ${extensionInstalled() ? "installed" : "not installed (run 'stacklore gh-install')"}`,
  );

  try {
    console.log(`repo     ${await currentRepo()}`);
    const branch = await currentBranch();
    console.log(`branch   ${branch || "—"}`);
    if (config && branch) {
      const repo = await currentRepo();
      const pr = await pullRequestForBranch(repo, branch);
      if (pr) {
        const layers = await getStack(repo, pr);
        const self = layers.find((l) => l.number === pr);
        const position = self?.stack.position;
        const size = self?.stack.size;
        const kind =
          position && size
            ? `(layer ${position}/${size}, ${
                self?.stack.source === "github"
                  ? `stack ${self.stack.number}`
                  : "inferred from base branches"
              })`
            : "(not stacked)";
        console.log(`pr       #${pr} ${kind}`);
      } else {
        console.log("pr       none open for this branch");
      }
    }
  } catch {
    console.log("repo     not a GitHub repository");
  }
}

async function cmdGhInstall(): Promise<void> {
  const { path, changed } = await installExtension();
  console.log(
    changed
      ? `Installed ${EXTENSION_NAME} at ${path}`
      : `${EXTENSION_NAME} is already up to date at ${path}`,
  );
  console.log("Run 'gh stacklore status' to confirm.");
}

async function cmdGhUninstall(): Promise<void> {
  console.log(
    (await uninstallExtension())
      ? `Removed ${EXTENSION_NAME}.`
      : `${EXTENSION_NAME} is not installed.`,
  );
}

async function main(): Promise<void> {

  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "init":
      await cmdInit(args);
      break;
    case "save":
      await cmdSave(args);
      break;
    case "show":
      await cmdShow(args);
      break;
    case "list":
      await cmdList(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "gh-install":
      await cmdGhInstall();
      break;
    case "gh-uninstall":
      await cmdGhUninstall();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`stacklore: unknown command '${args.command}'\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
