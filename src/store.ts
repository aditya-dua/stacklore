/**
 * Private lore store.
 *
 * GitHub visibility is per-repository: there are no per-ref, per-branch or
 * per-pull-request ACLs. Keeping records out of the source repository is
 * therefore the only way to restrict who can read them, so the store is a
 * separate private repository cloned into a local cache.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { reasonFor, runCommand, type CommandRunner } from "./exec.ts";
import { type LoreRecord, recordPath } from "./types.ts";

export interface StoreOptions {
  /** `owner/repo` of the private store repository. */
  repo: string;
  /** Local cache directory. Defaults to `~/.stacklore/store`. */
  cacheDir?: string;
  /** Subprocess runner. Injected by tests; defaults to a real `spawn`. */
  exec?: CommandRunner;
}

export class StoreError extends Error {}

/** Equality ignoring `capturedAt`, which changes on every capture run. */
function sameRecord(a: LoreRecord, b: LoreRecord): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Key-order-independent serialization with `capturedAt` removed. Stored records
 * are reparsed from disk, so their key order is not guaranteed to match a
 * freshly built record's.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "capturedAt")
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Identity used only when the machine has no git identity configured. Applied
 * per-command so it never writes to the user's git config.
 */
const FALLBACK_IDENTITY = [
  "-c",
  "user.name=stacklore",
  "-c",
  "user.email=stacklore@users.noreply.github.com",
];

export class LoreStore {
  readonly repo: string;
  readonly dir: string;
  readonly #exec: CommandRunner;
  #identity: string[] | null = null;

  constructor(options: StoreOptions) {
    this.repo = options.repo;
    this.dir =
      options.cacheDir ?? join(homedir(), ".stacklore", "store", options.repo);
    this.#exec = options.exec ?? runCommand;
  }

  async #git(args: string[]): Promise<string> {
    try {
      return await this.#exec("git", ["-C", this.dir, ...args]);
    } catch (error) {
      throw new StoreError(`git ${args.join(" ")} failed: ${reasonFor(error)}`);
    }
  }

  /**
   * `-c user.email=…` overrides configured values, so the fallback identity is
   * only ever supplied when the user genuinely has none. Resolved once.
   */
  async #identityArgs(): Promise<string[]> {
    if (this.#identity !== null) return this.#identity;
    try {
      const email = await this.#exec("git", [
        "-C",
        this.dir,
        "config",
        "user.email",
      ]);
      this.#identity = email.trim() ? [] : FALLBACK_IDENTITY;
    } catch {
      this.#identity = FALLBACK_IDENTITY;
    }
    return this.#identity;
  }

  /** Clone the store if absent, otherwise fast-forward it. */
  async sync(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      await mkdir(dirname(this.dir), { recursive: true });
      try {
        await this.#exec("gh", [
          "repo",
          "clone",
          this.repo,
          this.dir,
          "--",
          "--quiet",
        ]);
      } catch (error) {
        throw new StoreError(
          `Could not clone store '${this.repo}'. Run 'stacklore init' first. ${reasonFor(error)}`,
        );
      }
      return;
    }

    await this.#git(["fetch", "--quiet", "origin"]);

    // A store whose only commits are local, or whose remote is still empty, has
    // nothing to fast-forward onto; neither is an error. A genuinely diverged
    // store is recoverable by the user and surfaces on push instead.
    await this.#git(["pull", "--quiet", "--ff-only"]).catch(() => {});
  }

  /**
   * Create the private store repository if it does not already exist.
   *
   * `--add-readme` is not optional: a repository with no commits has an unborn
   * default branch, so the subsequent clone has no HEAD and the first push
   * would publish whatever `init.defaultBranch` happens to be locally rather
   * than the repository's own default.
   */
  static async create(
    repo: string,
    exec: CommandRunner = runCommand,
  ): Promise<boolean> {
    try {
      await exec("gh", ["repo", "view", repo]);
      return false;
    } catch {
      // Not found, continue to create.
    }
    try {
      await exec("gh", [
        "repo",
        "create",
        repo,
        "--private",
        "--add-readme",
        "--description",
        "Private stacklore store: prompts and intent behind stacked pull requests.",
      ]);
    } catch (error) {
      throw new StoreError(
        `Could not create store '${repo}': ${reasonFor(error)}`,
      );
    }
    return true;
  }

  /**
   * Write a record, unless an identical one is already stored.
   *
   * `capturedAt` moves on every run, so a naive write would dirty the tree and
   * push a commit each time `save` is invoked even when nothing about the pull
   * request changed. Comparing everything *except* the timestamp keeps `save`
   * idempotent and the store's history meaningful.
   */
  async write(record: LoreRecord): Promise<string> {
    const relative = recordPath(record.repo, record.pr);
    const absolute = join(this.dir, relative);

    const existing = await this.read(record.repo, record.pr);
    if (existing && sameRecord(existing, record)) return relative;

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return relative;
  }

  async read(repo: string, pr: number): Promise<LoreRecord | null> {
    const absolute = join(this.dir, recordPath(repo, pr));
    if (!existsSync(absolute)) return null;
    return JSON.parse(await readFile(absolute, "utf8")) as LoreRecord;
  }

  /** All records for a source repository, ascending by pull request number. */
  async list(repo: string): Promise<LoreRecord[]> {
    const dir = join(this.dir, "records", repo);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    const records: LoreRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      records.push(
        JSON.parse(await readFile(join(dir, entry), "utf8")) as LoreRecord,
      );
    }
    return records.sort((a, b) => a.pr - b.pr);
  }

  /** Commit and push pending changes. No-op when the tree is clean. */
  async commit(message: string): Promise<boolean> {
    const status = await this.#git(["status", "--porcelain"]);
    if (!status.trim()) return false;
    const identity = await this.#identityArgs();
    await this.#git(["add", "-A"]);
    await this.#git([...identity, "commit", "--quiet", "-m", message]);
    // `-u` so a freshly cloned store tracks its remote branch from the first
    // push onwards, rather than relying on push.default to guess.
    await this.#git(["push", "--quiet", "-u", "origin", "HEAD"]);
    return true;
  }

  /** Browser URL for a record, for linking from the public pull request. */
  recordUrl(repo: string, pr: number): string {
    return `https://github.com/${this.repo}/blob/HEAD/${recordPath(repo, pr)}`;
  }
}
