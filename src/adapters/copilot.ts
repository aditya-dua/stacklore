/**
 * GitHub Copilot capture adapter.
 *
 * Reads the local Copilot session store, joining `sessions.branch` to the
 * branch backing a pull request layer. The branch join is deliberate: it
 * survives the cascading rebases that stacked pull requests perform, whereas a
 * commit-SHA join would not.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runCommand, type CommandRunner } from "../exec.ts";
import type { Exchange } from "../types.ts";
import type { CaptureAdapter, CaptureQuery, CaptureResult } from "./types.ts";

const DEFAULT_DB = join(homedir(), ".copilot", "session-store.db");

/**
 * Location of the Copilot session store.
 *
 * Overridable so the adapter can be pointed at a fixture database in tests and
 * end-to-end runs without touching the user's real session history.
 */
export function copilotDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.STACKLORE_COPILOT_DB || DEFAULT_DB;
}

interface SessionRow {
  id: string;
  branch: string;
  repository: string | null;
  summary: string | null;
}

/** Run a query against the SQLite store and return JSON rows. */
async function query<T>(
  exec: CommandRunner,
  dbPath: string,
  sql: string,
): Promise<T[]> {
  const stdout = await exec("sqlite3", ["-readonly", "-json", dbPath, sql]);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as T[];
}

/** Escape a value for safe inline use in a SQLite string literal. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class CopilotAdapter implements CaptureAdapter {
  readonly name = "copilot";
  readonly #dbPath: string;
  readonly #exec: CommandRunner;

  constructor(dbPath: string = copilotDbPath(), exec: CommandRunner = runCommand) {
    this.#dbPath = dbPath;
    this.#exec = exec;
  }

  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.#dbPath)) return false;
    try {
      await this.#exec("sqlite3", ["-version"]);
      return true;
    } catch {
      return false;
    }
  }

  async capture(q: CaptureQuery): Promise<CaptureResult[]> {
    if (!(await this.isAvailable())) return [];

    const filters = [`branch = ${sqlString(q.branch)}`];
    if (q.repo) {
      // `repository` may be stored as a full URL or as owner/repo.
      filters.push(`(repository LIKE ${sqlString(`%${q.repo}%`)})`);
    }

    const sessions = await query<SessionRow>(
      this.#exec,
      this.#dbPath,
      `SELECT id, branch, repository, summary
         FROM sessions
        WHERE ${filters.join(" AND ")}
        ORDER BY updated_at DESC;`,
    );

    const results: CaptureResult[] = [];

    for (const session of sessions) {
      const id = sqlString(session.id);

      const turns = await query<{
        turn_index: number;
        user_message: string | null;
        assistant_response: string | null;
        timestamp: string | null;
      }>(
        this.#exec,
        this.#dbPath,
        `SELECT turn_index, user_message, assistant_response, timestamp
           FROM turns
          WHERE session_id = ${id}
            AND user_message IS NOT NULL
            AND TRIM(user_message) <> ''
          ORDER BY turn_index ASC;`,
      );

      const files = await query<{ file_path: string }>(
        this.#exec,
        this.#dbPath,
        `SELECT DISTINCT file_path
           FROM session_files
          WHERE session_id = ${id}
          ORDER BY file_path ASC;`,
      );

      const exchanges: Exchange[] = turns.map((t) => {
        const exchange: Exchange = {
          turn: t.turn_index,
          at: t.timestamp ?? "",
          prompt: t.user_message ?? "",
        };
        if (q.includeResponses && t.assistant_response) {
          exchange.response = t.assistant_response;
        }
        return exchange;
      });

      if (exchanges.length === 0) continue;

      results.push({
        tool: "copilot",
        adapter: this.name,
        sessionId: session.id,
        branch: session.branch,
        summary: session.summary,
        exchanges,
        files: files.map((f) => f.file_path),
      });
    }

    return results;
  }

  /** Pull request numbers this adapter has associated with a branch. */
  async linkedPullRequests(branch: string): Promise<number[]> {
    if (!(await this.isAvailable())) return [];
    const rows = await query<{ ref_value: string }>(
      this.#exec,
      this.#dbPath,
      `SELECT DISTINCT r.ref_value
         FROM session_refs r
         JOIN sessions s ON s.id = r.session_id
        WHERE r.ref_type = 'pr'
          AND s.branch = ${sqlString(branch)};`,
    );
    return rows
      .map((r) => Number.parseInt(r.ref_value.replace(/\D/g, ""), 10))
      .filter((n) => Number.isFinite(n));
  }
}
