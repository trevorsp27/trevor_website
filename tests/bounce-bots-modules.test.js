import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const gameDir = join(here, "..", "assets", "js", "bounce-bots");
const pagePath = join(here, "..", "pages", "bounce-bots.html");

function moduleFiles() {
  return readdirSync(gameDir).filter((f) => f.endsWith(".js"));
}

// GitHub Pages caches assets for ten minutes and the browser keys its module
// cache on the exact URL. Without a version token on every internal import, a
// freshly fetched main.js can be linked against a stale constants.js -- the
// module graph fails to resolve, boot() never runs, and the page renders fine
// while doing absolutely nothing. These tests exist because that happened.
test("every internal import carries a version token", () => {
  const offenders = [];

  moduleFiles().forEach((file) => {
    const source = readFileSync(join(gameDir, file), "utf8");
    const imports = source.match(/from\s+"\.\/[^"]+"/g) || [];
    imports.forEach((line) => {
      if (!line.includes("?v=")) offenders.push(`${file}: ${line}`);
    });
  });

  assert.deepEqual(offenders, [], "unversioned imports will break after a deploy");
});

test("all modules agree on one version token", () => {
  const tokens = new Set();

  moduleFiles().forEach((file) => {
    const source = readFileSync(join(gameDir, file), "utf8");
    (source.match(/\?v=([0-9a-z]+)/g) || []).forEach((m) => tokens.add(m));
  });

  assert.equal(tokens.size, 1, `mixed versions would defeat the point: ${[...tokens]}`);
});

test("the page entry point uses the same token as the modules", () => {
  const page = readFileSync(pagePath, "utf8");
  const entry = page.match(/bounce-bots\/main\.js\?v=([0-9a-z]+)/);
  assert.ok(entry, "the page must load main.js with a version token");

  const source = readFileSync(join(gameDir, "game.js"), "utf8");
  const internal = source.match(/\?v=([0-9a-z]+)/);
  assert.equal(
    entry[1],
    internal[1],
    "bumping the page without bumping the modules reintroduces the stale-mix bug"
  );
});

// The renderer is pure logic until a method touches the canvas, so it can be
// imported here. Doing so link-checks its imports -- which is exactly the
// failure the suite previously missed.
test("the renderer module resolves and exports what the page expects", async () => {
  const ui = await import("../assets/js/bounce-bots/ui.js");

  assert.equal(typeof ui.BoardView, "function");
  assert.equal(typeof ui.colorFor, "function");
  assert.equal(typeof ui.ROBOT_COLORS, "object");
  assert.equal(ui.colorFor("wild"), "#c77dff");
  assert.equal(ui.colorFor("red"), ui.ROBOT_COLORS.red);
});

test("the networking module resolves", async () => {
  const net = await import("../assets/js/bounce-bots/net.js");
  assert.equal(typeof net.createHost, "function");
  assert.equal(typeof net.createClient, "function");
  assert.equal(net.peerIdFor("ab7k"), "trevor-bouncebots-v1-AB7K");
});

test("every name the page's entry point imports actually exists", async () => {
  const source = readFileSync(join(gameDir, "main.js"), "utf8");
  const lines = source.match(/import\s+\{[^}]+\}\s+from\s+"\.\/[^"]+"/g) || [];
  assert.ok(lines.length > 0, "expected main.js to import something");

  for (const line of lines) {
    const names = line
      .match(/\{([^}]+)\}/)[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const file = line.match(/"\.\/([a-z]+\.js)/)[1];

    const mod = await import(`../assets/js/bounce-bots/${file}`);
    names.forEach((name) => {
      assert.ok(name in mod, `main.js imports ${name} from ${file}, which does not export it`);
    });
  }
});
