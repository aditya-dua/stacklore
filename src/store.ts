/**
 * Private lore store.
 *
 * GitHub visibility is per-repository: there are no per-ref, per-branch or
 * per-pull-request ACLs. Keeping records out of the source repository is
 * therefore the only way to restrict who can read them, so the store is a
 * separate private repository cloned into a local cache.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { type LoreRecord, recordPath } from "./types.js";

const execFileAsync = promisify(execFile);

export interface StoreOptions {
  /** `owner/repo` of the private store repository. */
  repo: string;
  /** Local cache directory. Defaults to `~/.stacklore/store`. */
  cacheDir?: string;
}

export class StoreError extends Error {}

export class LoreStore {
  readonly repo: string;
  readonly dir: string;

  constructor(options: StoreOptions) {
    this.repo = options.repo;
    this.dir =
      options.cacheDir ?? join(homedir(), ".stacklore", "store", options.repo);
  }

  async #git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.dir, ...args], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const message =
        error instanceof Error && "stderr" in error
          ? String((error as { stderr?: unknown }).stderr ?? error.message)
          : String(error);
      throw new StoreError(`git ${args.join(" ")} failed: ${message.trim()}`);
    }
  }

  /** Clone the store if absent, otherwise fast-forward it. */
  async sync(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      await mkdir(dirname(this.dir), { recursive: true });
      try {
        await execFileAsync("gh", [
          "repo",
          "clone",
          this.repo,
          this.dir,
          "--",
          "--quiet",
        ]);
      } catch (error) {
        const message =
          error instanceof Error && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? error.message)
            : String(error);
        throw new StoreError(
          `Could not clone store '${this.repo}'. Run 'stacklore init' first. ${message.trim()}`,
        );
      }
      return;
    }
    await this.#git(["fetch", "--quiet", "origin"]);
    await this.#git(["pull", "--quiet", "--ff-only"]).catch(() => {
      // A diverged store is recoverable by the user; surface on write instead.
    });
  }

  /** Create the private store repository if it does not already exist. */
  static async create(repo: string): Promise<void> {
    try {
      await execFileAsync("gh", ["repo", "view", repo]);
      return;
    } catch {
      // Not found, continue to create.
    }
    await execFileAsync("gh", [
      "repo",
      "create",
      repo,
      "--private",
      "--description",
      "Private stacklore store: prompts and intent behind stacked pull requests.",
    ]);
  }

  async write(record: LoreRecord): Promise<string> {
    const relative = recordPath(record.repo, record.pr);
    const absolute = join(this.dir, relative);
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
    await this.#git(["add", "-A"]);
    await this.#git(["commit", "--quiet", "-m", message]);
    await this.#git(["push", "--quiet", "origin", "HEAD"]);
    return true;
  }

  /** Browser URL for a record, for linking from the public pull request. */
  recordUrl(repo: string, pr: number): string {
    return `https://github.com/${this.repo}/blob/HEAD/${recordPath(repo, pr)}`;
  }
}
