import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandLines, runner } from "./helpers.ts";
import { LoreStore, StoreError } from "../src/store.ts";
import { SCHEMA_VERSION, type LoreRecord } from "../src/types.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "stacklore-store-"));
}

/** A cache directory that already looks like a clone. */
async function cloned(): Promise<string> {
  const dir = await scratch();
  await mkdir(join(dir, ".git"), { recursive: true });
  return dir;
}

function record(pr: number, overrides: Partial<LoreRecord> = {}): LoreRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: "acme/widgets",
    pr,
    branch: `layer-${pr}`,
    title: `Layer ${pr}`,
    stack: { number: 7, position: pr, size: 3, base: "main" },
    capturedAt: "2024-01-01T00:00:00.000Z",
    source: { tool: "copilot", adapter: "copilot", sessionId: "s1" },
    intent: `why layer ${pr} exists`,
    exchanges: [{ turn: 0, at: "2024-01-01T00:00:00.000Z", prompt: "do it" }],
    files: ["src/a.ts"],
    redactions: { count: 0, rules: [] },
    ...overrides,
  };
}

test("sync clones the store when the cache is empty", async () => {
  const dir = join(await scratch(), "nested", "acme", "lore");
  const { exec, calls } = runner([["repo clone", ""]]);

  await new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).sync();

  assert.deepEqual(calls[0]?.args, [
    "repo",
    "clone",
    "acme/lore",
    dir,
    "--",
    "--quiet",
  ]);
  // The parent of a nested cache path must be created before gh can clone.
  assert.ok(existsSync(join(dir, "..")));
});

test("sync fast-forwards an existing clone instead of recloning", async () => {
  const dir = await cloned();
  const { exec, calls } = runner([
    ["fetch", ""],
    ["pull", ""],
  ]);

  await new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).sync();

  const lines = commandLines(calls);
  assert.ok(!lines.some((line) => line.includes("repo clone")));
  assert.ok(lines.some((line) => line.includes("fetch --quiet origin")));
  assert.ok(lines.some((line) => line.includes("pull --quiet --ff-only")));
});

test("sync tolerates a store with nothing to fast-forward onto", async () => {
  // A freshly created store whose remote branch does not exist yet makes
  // `pull --ff-only` fail; that is not an error worth aborting a capture for.
  const dir = await cloned();
  const { exec } = runner([
    ["fetch", ""],
    [
      "pull",
      () => {
        throw new Error("no such ref");
      },
    ],
  ]);

  await new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).sync();
});

test("a failed clone points the user at init", async () => {
  const dir = join(await scratch(), "missing");
  const { exec } = runner([
    [
      "repo clone",
      () => {
        throw new Error("Could not resolve to a Repository");
      },
    ],
  ]);

  await assert.rejects(
    new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).sync(),
    (error: unknown) =>
      error instanceof StoreError && /stacklore init/.test(error.message),
  );
});

test("create is a no-op when the store repository already exists", async () => {
  const { exec, calls } = runner([["repo view", "acme/lore"]]);

  const created = await LoreStore.create("acme/lore", exec);

  assert.equal(created, false);
  assert.equal(calls.length, 1);
  assert.ok(!commandLines(calls).some((line) => line.includes("repo create")));
});

test("create makes a private repository with an initial commit", async () => {
  const { exec, calls } = runner([
    [
      "repo view",
      () => {
        throw new Error("Not Found");
      },
    ],
    ["repo create", ""],
  ]);

  const created = await LoreStore.create("acme/lore", exec);

  assert.equal(created, true);
  const args = calls[1]?.args ?? [];
  assert.ok(args.includes("--private"));
  // Without an initial commit the default branch is unborn, so the first push
  // would publish the local init.defaultBranch instead of the repo's own.
  assert.ok(args.includes("--add-readme"));
});

test("a failed create surfaces as StoreError", async () => {
  const { exec } = runner([
    [
      "repo view",
      () => {
        throw new Error("Not Found");
      },
    ],
    [
      "repo create",
      () => {
        throw new Error("name already exists on this account");
      },
    ],
  ]);

  await assert.rejects(
    LoreStore.create("acme/lore", exec),
    (error: unknown) => error instanceof StoreError,
  );
});

test("records round-trip through a pull-request-keyed path", async () => {
  const dir = await cloned();
  const { exec } = runner([]);
  const store = new LoreStore({ repo: "acme/lore", cacheDir: dir, exec });

  const relative = await store.write(record(12));

  assert.equal(relative, "records/acme/widgets/pr-12.json");
  const read = await store.read("acme/widgets", 12);
  assert.equal(read?.intent, "why layer 12 exists");
});

test("reading an absent record yields null", async () => {
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });

  assert.equal(await store.read("acme/widgets", 404), null);
});

test("a record identical but for capturedAt is not rewritten", async () => {
  // capturedAt moves every run, so rewriting on timestamp alone would push an
  // empty commit on every save.
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });

  await store.write(record(3));
  await store.write(record(3, { capturedAt: "2025-06-01T12:00:00.000Z" }));

  const read = await store.read("acme/widgets", 3);
  assert.equal(read?.capturedAt, "2024-01-01T00:00:00.000Z");
});

test("a record that changed in substance is rewritten", async () => {
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });

  await store.write(record(3));
  await store.write(
    record(3, { capturedAt: "2025-06-01T12:00:00.000Z", intent: "new intent" }),
  );

  const read = await store.read("acme/widgets", 3);
  assert.equal(read?.intent, "new intent");
  assert.equal(read?.capturedAt, "2025-06-01T12:00:00.000Z");
});

test("key order on disk does not defeat the identical-record check", async () => {
  // Stored records are reparsed from disk, so their key order need not match a
  // freshly built record's; comparison has to be order-independent.
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });
  const original = record(5);
  const reordered = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as unknown as LoreRecord;

  await store.write(reordered);
  const before = await readFile(
    join(dir, "records/acme/widgets/pr-5.json"),
    "utf8",
  );
  await store.write({ ...original, capturedAt: "2030-01-01T00:00:00.000Z" });

  assert.equal(
    await readFile(join(dir, "records/acme/widgets/pr-5.json"), "utf8"),
    before,
  );
});

test("list is sorted ascending by pull request number", async () => {
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });
  for (const pr of [30, 4, 11]) await store.write(record(pr));
  await writeFile(join(dir, "records/acme/widgets/notes.txt"), "ignore", "utf8");

  const listed = await store.list("acme/widgets");

  assert.deepEqual(
    listed.map((item) => item.pr),
    [4, 11, 30],
  );
});

test("listing an unknown repository yields an empty list", async () => {
  const dir = await cloned();
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec: runner([]).exec,
  });

  assert.deepEqual(await store.list("acme/nothing"), []);
});

test("commit is a no-op on a clean tree", async () => {
  const dir = await cloned();
  const { exec, calls } = runner([["status --porcelain", "\n"]]);

  const committed = await new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec,
  }).commit("nothing to do");

  assert.equal(committed, false);
  assert.equal(calls.length, 1);
});

test("commit stages, commits and pushes with upstream tracking", async () => {
  const dir = await cloned();
  const { exec, calls } = runner([
    ["status --porcelain", "A  records/acme/widgets/pr-1.json\n"],
    ["config user.email", "dev@example.com\n"],
    ["add -A", ""],
    ["commit", ""],
    ["push", ""],
  ]);

  const committed = await new LoreStore({
    repo: "acme/lore",
    cacheDir: dir,
    exec,
  }).commit("stacklore: capture");

  assert.equal(committed, true);
  const lines = commandLines(calls);
  assert.ok(lines.some((line) => line.includes("add -A")));
  // `-u` so a freshly cloned store tracks its branch from the first push.
  assert.ok(lines.some((line) => line.includes("push --quiet -u origin HEAD")));
});

test("a configured git identity is never overridden", async () => {
  const dir = await cloned();
  const { exec, calls } = runner([
    ["status --porcelain", " M a\n"],
    ["config user.email", "dev@example.com\n"],
    ["add -A", ""],
    ["commit", ""],
    ["push", ""],
  ]);

  await new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).commit("x");

  const commit = calls.find((call) => call.args.includes("commit"));
  assert.ok(!commit?.args.some((arg) => arg.startsWith("user.email=")));
});

test("a fallback identity is supplied only when none is configured", async () => {
  const dir = await cloned();
  const { exec, calls } = runner([
    ["status --porcelain", " M a\n"],
    ["config user.email", ""],
    ["add -A", ""],
    ["commit", ""],
    ["push", ""],
  ]);

  await new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).commit("x");

  const commit = calls.find((call) => call.args.includes("commit"));
  assert.ok(
    commit?.args.includes("user.email=stacklore@users.noreply.github.com"),
  );
});

test("a git failure surfaces as StoreError with the command that failed", async () => {
  const dir = await cloned();
  const { exec } = runner([
    [
      "status --porcelain",
      () => {
        throw new Error("not a git repository");
      },
    ],
  ]);

  await assert.rejects(
    new LoreStore({ repo: "acme/lore", cacheDir: dir, exec }).commit("x"),
    (error: unknown) =>
      error instanceof StoreError && /status --porcelain/.test(error.message),
  );
});

test("record urls point into the private store, not the source repo", async () => {
  const store = new LoreStore({
    repo: "acme/lore",
    cacheDir: "/tmp/unused",
    exec: runner([]).exec,
  });

  assert.equal(
    store.recordUrl("acme/widgets", 12),
    "https://github.com/acme/lore/blob/HEAD/records/acme/widgets/pr-12.json",
  );
});
