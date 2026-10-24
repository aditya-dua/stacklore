/**
 * Configuration.
 *
 * Config is intentionally committed to the source repository: it holds only the
 * name of the private store, never its contents. Knowing a private repository's
 * name discloses nothing to anyone without access to it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = ".stacklore.json";

export interface StackloreConfig {
  /** `owner/repo` of the private store repository. */
  store: string;
  /** Preferred capture adapter. Auto-detected when omitted. */
  adapter?: string;
  /** Persist assistant responses alongside prompts. */
  includeResponses?: boolean;
  /** Post or update a lore comment on the pull request. */
  comment?: boolean;
}

export const DEFAULT_CONFIG: Omit<StackloreConfig, "store"> = {
  includeResponses: false,
  comment: true,
};

export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<StackloreConfig | null> {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, "utf8")) as StackloreConfig;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(
  config: StackloreConfig,
  cwd: string = process.cwd(),
): Promise<string> {
  const path = join(cwd, CONFIG_FILE);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}
