/* THE LAWNMOWER, which had no test at all and one number that made it
 * pointless.
 *
 * `push` was 1.25 against a roster whose walk runs 1.24 to 1.58, so every
 * fighter in the game except JohnnyHam could hold back on the stick and never
 * be touched by it. A probe across six starting gaps and four things a victim
 * can do said exactly that -- a victim walking away took 0.0 damage from all
 * six -- and the move as a whole connected on 42% of casts for a mean of 2.67
 * damage, having committed him for 72 frames and a third of a mana bar. At
 * push 2 the same probe reads 71% and 5.50 over 62 frames.
 *
 * That is pinned here as an INVARIANT against the roster rather than as the
 * literal 2, because the number that matters is a comparison: the day
 * somebody gives a new fighter a faster walk, this move quietly goes back to
 * being the thing it was, and nothing else in the file would notice.
 *
 * The other three tests are the parts that are code rather than numbers --
 * `shreds`, `feeds` and `mulch` -- each with a negative control where a
 * control is cheap, because all three are "something did not happen" tests
 * and those pass beautifully when the harness is broken.
 *
 * The engine source is loaded directly, the way the milk and New Deal tests
 * do: Mower, Puddle, `projectiles` and canSpecial are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

let __seedCounter = 0;
function seededMath() {
  let s = (0x5bf03635 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
  const M = Object.create(Math);
  M.random = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return M;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, "..", "assets", "js", "nerdwars");
const SPRITES_SRC = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {}, __on: {},
    getContext: () => new Proxy({}, {
      get: (t, k) => (k === "canvas" ? { width: 320, height: 180 }
        : k === "measureText" ? () => ({ width: 0 })
        : k === "createLinearGradient" || k === "createRadialGradient"
          ? () => ({ addColorStop() {} })
        : k in t ? t[k] : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    addEventListener(type, fn) { (el.__on[type] = el.__on[type] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = { clientWidth: w, clientHeight: h, contains: () => true, dataset: {} };
  return el;
}

async function bootEngine(engineSrc) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set,
    Number, String, Boolean, Error, DataView, ArrayBuffer, Uint8Array,
    Float32Array, Float64Array, isNaN, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    innerWidth: 960, innerHeight: 540, addEventListener() {},
    Image: class {
      constructor() { this.complete = true; this.naturalWidth = 16; this.naturalHeight = 16; }
      set src(v) { if (this.onload) this.onload(); }
    },
    document: {
      getElementById: (id) => (id === "nw-canvas" || id === "game" ? view : null),
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener() {},
      documentElement: {},
      fullscreenElement: null,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SPRITES_SRC, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return { run: (src) => vm.runInContext(src, sandbox) };
}

/* One line of the engine changed in memory, both halves asserted: a needle
   that is missing, or is there twice, makes a control that silently mutates
   nothing or mutates the wrong thing. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

function expectToFail(check, why) {
  try { check(); } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

const SP_NEUTRAL = 512, SP_DOWN = 1024;

/* Houston in seat 0 against whoever is named, both parked on the main floor
   with every timer that could eat an input cleared -- `freezeFrames`
   especially, since a measurement that starts inside somebody else's freeze
   spends its frames on nothing. */
async function arena(foeKey, engineSrc) {
  const booted = await bootEngine(engineSrc);
  const { run } = booted;
  const order = JSON.parse(run("JSON.stringify(ORDER)"));
  const H = order.indexOf("houston"), F = order.indexOf(foeKey || "reese");
  assert.ok(H >= 0 && F >= 0, "precondition: both fighters should be in ORDER");
  run("select.cursor=[" + H + ", " + F + "]; twoPlayer=true; playerCount=2;" +
      " humanCount=0; stagePick=0; practice=false; startBattle();");
  run("for (var i=0;i<90;i++) step();");
  assert.equal(run("fighters[0].key"), "houston",
    "precondition: houston should be in seat 0");
  run([
    "var MAIN, MOW, PUD;",
    "MOW = ROSTER.houston.specials.down;",
    "PUD = ROSTER.houston.specials.neutral.puddle;",
    "function seat(gap) {",
    "  MAIN = STAGE.platforms.find(function (p) { return p.main; });",
    "  projectiles.length = 0; effects.length = 0; freezeFrames = 0;",
    "  fighters.forEach(function (f) {",
    "    f.setState('idle'); f.timer = 0; f.hitstun = 0; f.hitstop = 0;",
    "    f.landLag = 0; f.invuln = 0; f.mana = 100; f.vx = 0; f.vy = 0;",
    "    f.grounded = true; f.y = MAIN.y; f.slick = 0; f.slickFoe = 0;",
    "    f.stocks = 9; f.health = 100; f.eliminated = false; f.combo = 0;",
    "    f.hasHit = false; f.attackFrame = 0; f.specialSpawned = false;",
    "    f.sinceHitFrames = 999;",
    "  });",
    "  fighters[0].x = MAIN.x + 55; fighters[0].facing = 1;",
    "  fighters[1].x = fighters[0].x + (gap == null ? 120 : gap);",
    "  fighters[1].facing = -1;",
    "  netplay.active = true;",
    "}",
    "function tick(a, b) {",
    "  netplay.framePads = [bitsToPad(a || 0), bitsToPad(b || 0)]; step();",
    "}",
    "function decks() {",
    "  return projectiles.filter(function (p) { return !p.dead && p.spec === MOW; });",
    "}",
    "function spills() {",
    "  return projectiles.filter(function (p) { return !p.dead && p.spec === PUD; });",
    "}",
  ].join("\n"));
  return booted;
}

test("the deck has to outrun a walk, or holding back beats it outright",
  async () => {
    /* The comparison IS the test. At 1.25 the move connected on 42% of casts
       for 2.67 damage because every fighter but one could simply walk away
       from it; the literal number is not what keeps that from coming back,
       the margin over the fastest man on the roster is. */
    const { run } = await arena();
    const walks = JSON.parse(run(
      "JSON.stringify(ORDER.map(function (k) { return [k, ROSTER[k].walk]; }))"));
    const push = Number(run("MOW.push"));
    walks.sort((a, b) => b[1] - a[1]);
    const [fastestKey, fastest] = walks[0];

    assert.ok(push > fastest,
      "the mower roots him for " + run("MOW.active") + " frames and cannot " +
      "be steered, so it has to catch somebody who simply holds back: push " +
      "is " + push + " against " + fastestKey + "'s walk of " + fastest);
    /* And by enough to matter. Catching a retreating man at a hundredth of a
       pixel a frame is arithmetically true and worth nothing over the length
       of the move. */
    assert.ok(push - fastest > 0.2,
      "and by a margin that closes ground inside the move: it gains only " +
      (push - fastest).toFixed(3) + "px a frame on " + fastestKey);

    // What that buys, in the only unit that matters: floor swept.
    const swept = push * Number(run("MOW.active"));
    assert.ok(swept > 70,
      "a mower that travels less than a body-length is a kick with extra " +
      "commitment; this one sweeps " + swept.toFixed(0) + "px");
  });

test("a mower has wheels: it is refused in the air, and the mana is kept",
  async () => {
    const { run } = await arena();
    const r = run("(function () {\n" +
      "  seat();\n" +
      "  fighters[0].grounded = false; fighters[0].y -= 30;\n" +
      "  var before = fighters[0].mana;\n" +
      // canSpecial takes the PAD and resolves the slot itself; handing it a
      // spec silently asks about the neutral special, which is legal in the air.
      "  var ok = fighters[0].canSpecial(bitsToPad(" + SP_DOWN + "));\n" +
      "  tick(" + SP_DOWN + ");\n" +
      "  return { ok: ok, before: before, after: fighters[0].mana,\n" +
      "           decks: decks().length, state: fighters[0].state };\n" +
      "})()");
    assert.equal(r.ok, false, "canSpecial must refuse a mower off the floor");
    assert.equal(r.decks, 0, "and no deck should exist; there were " + r.decks);
    assert.ok(r.after >= r.before,
      "and the mana must not be spent on a move that was refused: " +
      r.before + " -> " + r.after);
  });

test("the deck eats an enemy shot and the eating pays for the move",
  async () => {
    /* `shreds` is the only copy of this on the roster and it was priced as
       though it were not there. `feeds` is what makes walking into a screen
       full of somebody else's projectiles affordable as the answer to a
       screen full of projectiles. */
    const { run } = await arena("cobeus");
    const PROBE = "(function () {\n" +
      "  seat(110);\n" +
      "  fighters[1].mana = 999;\n" +
      "  tick(0, " + SP_NEUTRAL + ");\n" +
      "  for (var i = 0; i < 18; i++) tick(0, 0);\n" +
      "  var born = projectiles.filter(function (p) { return !p.dead; }).length;\n" +
      "  fighters[0].mana = 60;\n" +
      "  var atPress = fighters[0].mana;\n" +
      "  tick(" + SP_DOWN + ", 0);\n" +
      "  for (var j = 0; j < 70; j++) { fighters[0].hitstop = 0; tick(0, 0); }\n" +
      "  var left = projectiles.filter(function (p) {\n" +
      "    return !p.dead && p.spec !== MOW; }).length;\n" +
      "  return { born: born, left: left, atPress: atPress,\n" +
      "           after: fighters[0].mana, cost: MOW.mana, feeds: MOW.feeds,\n" +
      "           max: COMBAT.manaMax };\n" +
      "})()";
    const r = run(PROBE);
    assert.ok(r.born > 0, "precondition: the foe should have put a shot on the stage");
    assert.equal(r.left, 0,
      "the deck must destroy the enemy shot it drives through; " + r.left + " survived");
    assert.ok(r.feeds > 0 && r.feeds < r.cost,
      "the refund has to be worth having and worth less than the cast, or " +
      "one shot is a free mower: feeds " + r.feeds + " against " + r.cost);

    /* THE REFUND MEASURED AGAINST ITSELF. Mana regenerates every frame and
       the cast is spent somewhere inside the window, so an absolute figure
       here would be arithmetic about the harness. The same probe on an
       engine identical but for `feeds` gives the one number that is the
       refund and nothing else -- and doubles as the negative control, since
       a broken probe produces no difference at all. */
    const off = await arena("cobeus", sabotage("      feeds: 12,", "      feeds: 0,"));
    const q = off.run(PROBE);
    assert.equal(q.left, 0,
      "precondition: the control engine still shreds; " + q.left + " survived");
    assert.equal(r.after - q.after, r.feeds,
      "eating one shot should leave him exactly `feeds` better off than the " +
      "same cast on an engine that does not pay: " + r.after + " against " +
      q.after + ", a difference of " + (r.after - q.after) + " where feeds " +
      "is " + r.feeds);
  });

test("the deck mulches his own fresh milk and leaves everybody else's alone",
  async () => {
    /* The spill's damaging half runs on a clock nobody watches. Mulching is
       what makes WHEN it turns a decision he gets to make, and it is the one
       place two of his own moves combine. */
    const { run } = await arena();
    const MULCH = "(function (mine) {\n" +
      "  seat(200);\n" +
      "  var owner = mine ? fighters[0] : fighters[1];\n" +
      "  var p = new Puddle(owner, PUD, fighters[0].x + 40, MAIN.y);\n" +
      "  projectiles.push(p);\n" +
      "  var was = { curdled: p.curdled(), life: p.life };\n" +
      "  tick(" + SP_DOWN + ", 0);\n" +
      "  for (var i = 0; i < MOW.startup + MOW.active; i++) tick(0, 0);\n" +
      "  return { was: was, curdled: p.curdled(), life: p.life, dead: p.dead,\n" +
      "           full: PUD.life, curdle: PUD.curdle };\n" +
      "})";
    const mine = run(MULCH + "(true)");
    assert.equal(mine.was.curdled, false, "precondition: it starts fresh");
    assert.equal(mine.dead, false, "mulching must not destroy the spill");
    assert.equal(mine.curdled, true,
      "the deck over his own fresh spill has to turn it");
    assert.ok(mine.life > mine.full - 80,
      "and start its life over, or turning it early is a way of ending it " +
      "early: it has " + mine.life + " of " + mine.full + " frames left");

    const theirs = run(MULCH + "(false)");
    assert.equal(theirs.curdled, false,
      "and somebody else's milk is not his to turn; it read curdled");

    /* NEGATIVE CONTROL: the flag off, on an otherwise identical engine. */
    const off = await arena("reese", sabotage("      mulch: true,", "      mulch: false,"));
    const q = off.run(MULCH + "(true)");
    expectToFail(() => { assert.equal(q.curdled, true); },
      "with mulch off the spill should not have turned and the check should " +
      "have failed");
  });

test("the deck goes with the man, and does not eat another deck", async () => {
  /* A projectile-eater that outlived the man pushing it would be a free
     screen clear off any trade, and two shredders that annihilated on
     contact would make the mirror a coin toss on who pressed first. */
  const { run } = await arena("houston");
  const r = run("(function () {\n" +
    /* Far enough apart that neither reaches the other inside the window: two
       mowers that meet knock each other out of the move, which is a true
       thing about the game and not the thing this test is asking about. */
    "  seat(150); fighters[1].facing = -1;\n" +
    "  tick(" + SP_DOWN + ", " + SP_DOWN + ");\n" +
    "  for (var i = 0; i < 20; i++) tick(0, 0);\n" +
    "  var both = decks().length;\n" +
    "  fighters[0].setState('hitstun'); fighters[0].hitstun = 20;\n" +
    "  fighters[0].grounded = false;\n" +
    "  tick(0, 0);\n" +
    "  var mine = decks().filter(function (d) { return d.owner === fighters[0]; }).length;\n" +
    "  return { both: both, mine: mine };\n" +
    "})()");
  assert.equal(r.both, 2,
    "two mowers should grind past each other rather than annihilate; " +
    r.both + " were on the stage");
  assert.equal(r.mine, 0,
    "and a deck must not outlive the man pushing it; " + r.mine + " did");
});
