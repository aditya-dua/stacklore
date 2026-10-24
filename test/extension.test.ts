import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXTENSION_NAME,
  extensionDir,
  extensionInstalled,
  installExtension,
  shimScript,
  uninstallExtension,
} from "../src/extension.ts";

async function fakeHome(): Promise<NodeJS.ProcessEnv> {
  return { XDG_DATA_HOME: await mkdtemp(join(tmpdir(), "stacklore-gh-")) };
}

test("the extension lives where gh looks for it", async () => {
  const env = { XDG_DATA_HOME: "/data" };

  assert.equal(extensionDir(env), "/data/gh/extensions/gh-stacklore");
  // gh only recognises extensions whose directory and executable start with
  // `gh-`; the subcommand is whatever follows.
  assert.ok(EXTENSION_NAME.startsWith("gh-"));
});

test("an empty XDG_DATA_HOME falls back to the default location", () => {
  assert.match(
    extensionDir({ XDG_DATA_HOME: "" }),
    /\.local[/\\]share[/\\]gh[/\\]extensions[/\\]gh-stacklore$/,
  );
});

test("install writes an executable shim", async () => {
  const env = await fakeHome();

  const result = await installExtension({ env, node: "/n/node", cli: "/c.js" });

  assert.equal(result.changed, true);
  const mode = (await stat(result.path)).mode & 0o777;
  // gh execs the file directly, so it has to carry the executable bit.
  assert.equal(mode & 0o111, 0o111);
  const body = await readFile(result.path, "utf8");
  assert.match(body, /^#!\/usr\/bin\/env bash/);
  assert.ok(body.includes('"/n/node" "/c.js" "$@"'));
});

test("reinstalling an unchanged shim reports no change", async () => {
  const env = await fakeHome();
  const options = { env, node: "/n/node", cli: "/c.js" };

  await installExtension(options);
  const second = await installExtension(options);

  assert.equal(second.changed, false);
});

test("a moved node or cli path refreshes the shim", async () => {
  const env = await fakeHome();
  await installExtension({ env, node: "/old/node", cli: "/c.js" });

  const result = await installExtension({ env, node: "/new/node", cli: "/c.js" });

  assert.equal(result.changed, true);
  assert.ok((await readFile(result.path, "utf8")).includes("/new/node"));
});

test("paths containing spaces stay a single argument", async () => {
  // Homebrew-free macOS installs land under '/Users/<name>/Library/Application
  // Support/...', so unquoted paths would split mid-command.
  const script = shimScript("/usr/local/n o d e", "/My Files/cli.js");

  assert.ok(script.includes('"/usr/local/n o d e" "/My Files/cli.js" "$@"'));
});

test("arguments are forwarded verbatim to the cli", () => {
  // `"$@"` rather than `$*`, so 'gh stacklore save --pr 3' keeps its words.
  assert.ok(shimScript("/node", "/cli.js").trimEnd().endsWith('"$@"'));
});

test("install reports the extension as present, uninstall removes it", async () => {
  const env = await fakeHome();
  assert.equal(extensionInstalled(env), false);

  await installExtension({ env, node: "/n", cli: "/c.js" });
  assert.equal(extensionInstalled(env), true);

  assert.equal(await uninstallExtension({ env }), true);
  assert.equal(extensionInstalled(env), false);
  assert.equal(existsSync(extensionDir(env)), false);
});

test("uninstalling when nothing is installed is not an error", async () => {
  const env = await fakeHome();

  assert.equal(await uninstallExtension({ env }), false);
});

test("install creates gh's extension directory if it is missing", async () => {
  const env = await fakeHome();

  const result = await installExtension({ env, node: "/n", cli: "/c.js" });

  assert.equal(result.path, join(extensionDir(env), EXTENSION_NAME));
  assert.ok(existsSync(result.path));
});

test("an unreadable existing shim is replaced rather than compared", async () => {
  const env = await fakeHome();
  const dir = extensionDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, EXTENSION_NAME), "stale", "utf8");

  const result = await installExtension({ env, node: "/n", cli: "/c.js" });

  assert.equal(result.changed, true);
  assert.ok((await readFile(result.path, "utf8")).includes('"/n" "/c.js"'));
});
