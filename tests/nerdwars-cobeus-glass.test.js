/* COBEUS' BROKEN GLASS, and the thing it never did until 2.83: GO AWAY
 * VISIBLY.
 *
 * Until this release a pane that had served its purpose simply stopped
 * existing. `graze` returns out of applyHit before the hit spark and before
 * cue('hit'), and the pane's own death was a boolean, so on the frame
 * somebody stepped in it there were zero effects, zero cues, and on the next
 * frame there was nothing on the floor. The whole point of a floor hazard is
 * that both players can see where it is and see when it is spent, and half
 * of that was missing. NOTHING IN THE SUITE WOULD HAVE NOTICED. That is the
 * defect this file exists for, and it is why most of what is asserted below
 * is about pixels and sounds rather than about damage -- nerdwars-255 owns
 * the damage and the 2.55 hopping regression, and nothing here goes near it.
 *
 * The other half is the budget. A pane now has TWO steps in it with thirty
 * frames of being no hitbox at all in between, so there are three looks to
 * tell apart and two different animations to play, and the wrong one under a
 * foot is a bug a player would report as "it hit me twice in a row".
 *
 * Everything is driven through netplay pads, one per seat, the same way a
 * rollback replays a frame, and every drawing is captured off the engine's
 * own draw calls through a recording context -- so what is measured is what
 * the game paints and not what this file thinks it paints.
 *
 * Every test has a NEGATIVE CONTROL beside it: the same measurement against
 * a copy of the engine with one line changed in memory, and the check is
 * that the same assertions then fail. The mutated copies live in a string
 * and a fresh vm and are never written anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

/* Each vm gets its own Math.random stream -- node --test runs files
   concurrently, and a shared sequence makes any measurement that averages
   over AI behavior different on every run. */
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
const SPRITES = readFileSync(path.join(JS_DIR, "sprites.js"), "utf8");
const ENGINE_PATH = path.join(HERE, "..", "..", "NerdWars", "src", "nerdwars.js");

function stubContext() {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 0 });
      if (key === "canvas") return { width: 0, height: 0 };
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function stubCanvas(w, h) {
  const el = {
    width: w, height: h, style: {},
    getContext: () => stubContext(),
    __on: {},
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
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    innerWidth: 960, innerHeight: 540, addEventListener() {},
    Image: class {
      constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; }
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
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

/* One line of the engine, changed in memory. Both halves asserted: a needle
   that is not there, or is there twice, makes a control that silently
   mutates nothing or mutates the wrong thing -- which is exactly the failure
   a negative control exists to rule out. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* TWO lines of the engine, changed in memory. Two sabotage() calls cannot be
   chained -- each one re-reads the file off disk -- so the second needle is
   applied to the string the first one returned. Both halves of both are
   asserted, for the same reason one needle's are.

   This exists because some defects are an ARRANGEMENT rather than a line: a
   statement in the wrong place is only wrong relative to the one it should
   have been below, and a control that puts back the first without taking away
   the second is measuring a third thing that never shipped. */
function sabotageBoth(n1, r1, n2, r2) {
  const src = sabotage(n1, r1);
  const at = src.indexOf(n2);
  assert.ok(at >= 0, "second sabotage needle not found: " + JSON.stringify(n2));
  assert.equal(src.indexOf(n2, at + 1), -1,
    "second sabotage needle is not unique: " + JSON.stringify(n2));
  return src.slice(0, at) + r2 + src.slice(at + n2.length);
}

function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}

const SP_NEUTRAL = 512, SP_UP = 2048;
const REESE = 4, COBEUS = 6;

/* A recording context, written as source because it is built INSIDE the vm.
   fillRect and drawImage only: everything else is swallowed, because what is
   being measured is the rectangles the pane and its debris paint and a save()
   is not one. */
const RECORDER = `
  function REC() {
    return { ops: [], globalAlpha: 1, fillStyle: '#000',
      fillRect: function (x, y, w, h) {
        this.ops.push({ x: x, y: y, w: w, h: h, c: this.fillStyle,
                        a: +this.globalAlpha.toFixed(4) }); },
      drawImage: function () { this.ops.push({ img: 1 }); },
      strokeRect: function () {}, beginPath: function () {}, arc: function () {},
      ellipse: function () {}, stroke: function () {}, save: function () {},
      restore: function () {}, translate: function () {}, rotate: function () {},
      moveTo: function () {}, lineTo: function () {}, closePath: function () {},
      fill: function () {} };
  }`;

/* Cobeus' pane on the floor, stepped in TWICE -- once at +20 and once at
   +70, which is past the thirty frames it spends settling -- with the victim
   kept off it on every other frame so the two events are cleanly separated.
   Everything drawn on every frame is recorded, along with the effects census
   and every cue the engine emitted. */
const lifecycle = (run) => JSON.parse(run(`(function () {
  ${RECORDER}
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grounded = true; me.facing = 1; me.specialSpawned = false;
  me.x = main.x + 30; me.y = main.y;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 99; foe.eliminated = false; foe.health = 1000; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.x = main.x + main.w - 12; foe.invuln = 9999;

  var oldCue = cue, cues = [];
  cue = function (nm, o) { cues.push(String(nm)); return oldCue(nm, o); };

  var bornAt = -1, frames = [], bites = [], census = {};
  netplay.active = true;
  for (var i = 0; i < 200; i++) {
    me.hitstop = 0; me.mana = 999;
    var g = projectiles.filter(function (q) {
      return q.constructor.name === 'Glass' && !q.dead; })[0];
    if (g && bornAt < 0) bornAt = i;
    var want = bornAt >= 0 && (i === bornAt + 20 || i === bornAt + 70);
    if (g && want) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0; foe.setState('idle');
      foe.x = g.x; foe.y = main.y; foe.vx = 0; foe.vy = 0; foe.grounded = true;
    } else {
      foe.x = main.x + main.w - 12; foe.invuln = 9999;
    }
    var h0 = foe.health;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
    step();
    if (foe.health < h0 - 0.0001) bites.push(i - bornAt);
    if (bornAt < 0) continue;
    var off = i - bornAt;
    if (off === 20 || off === 70) {
      var c = { splinter: 0, sliver: 0 };
      for (var q = 0; q < effects.length; q++) {
        if (c[effects[q].kind] !== undefined) c[effects[q].kind]++;
      }
      census[off === 20 ? 'crack' : 'brk'] = c;
    }
    var r = REC();
    var pane = projectiles.filter(function (q) {
      return q.constructor.name === 'Glass' && !q.dead; })[0];
    if (pane) pane.draw(r);
    drawEffects(r);
    frames.push({ off: off, rects: r.ops.length,
                  ops: (off >= 69 && off <= 74) ? r.ops : null });
  }
  netplay.active = false; netplay.framePads = null;
  cue = oldCue;
  var glass = ROSTER.cobeus.specials.neutral.glass;
  return JSON.stringify({
    bornAt: bornAt, bites: bites, census: census,
    crackCues: cues.filter(function (c) { return c === 'glass-crack'; }).length,
    breakCues: cues.filter(function (c) { return c === 'glass-break'; }).length,
    shieldCues: cues.filter(function (c) { return c === 'shield-break'; }).length,
    recipes: Object.keys(AUDIO_RECIPES).filter(function (k) {
      return k.indexOf('glass-') === 0; }).sort(),
    peak: frames.reduce(function (m, f) { return Math.max(m, f.rects); }, 0),
    w: glass.w, h: glass.h,
    frames: frames });
})()`));

function beat(r, n) {
  return r.frames.filter(function (f) { return f.off === 70 + n; })[0];
}

/* ------------------------------------------------------------------ */

function checkCensus(r) {
  assert.ok(r.bornAt >= 0, "precondition: the bottle should have left a pane");
  assert.deepEqual(r.bites, [20, 70],
    "precondition: the two steps have to land where the probe put them, at " +
    "+20 and +70; they landed at " + JSON.stringify(r.bites));
  assert.equal(r.census.brk.splinter, 1,
    "the break spawns exactly one `splinter` -- the pane itself coming " +
    "apart, drawn once and not once per piece; it spawned " +
    r.census.brk.splinter);
  assert.equal(r.census.brk.sliver, 14,
    "and FOURTEEN slivers, because the pane is fourteen pixels: IMG.glass " +
    "decodes to eight by eight with fourteen opaque cells, so a break " +
    "throws the thing apart into literally every pixel it was made of, " +
    "label included. It threw " + r.census.brk.sliver);
  assert.equal(r.census.crack.splinter, 1,
    "the FIRST step is the same vocabulary at a third of the volume: one " +
    "splinter, a seam rather than a footprint; it spawned " +
    r.census.crack.splinter);
  assert.equal(r.census.crack.sliver, 4,
    "and four slivers, not fourteen -- a pane that is still standing has " +
    "not come apart yet, and spending the whole shower on the first step " +
    "is what makes the second one read as nothing. It threw " +
    r.census.crack.sliver);
}

test("a pane that breaks throws every pixel it was made of", async () => {
  const run = await arena(COBEUS, REESE);
  checkCensus(lifecycle(run));
});

test("negative control: a break that sheds a crack's worth of glass fails the census test", async () => {
  /* The failure that would be easiest to ship and hardest to see: the break
     still plays, still sounds, still costs the right damage -- and throws
     four pieces, so the second step looks like the first one and the pane
     going reads as the pane cracking again. */
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "  glassSlivers(x, y, w, 14, 2.3);",
    "  glassSlivers(x, y, w, 4, 2.3);") });
  const r = lifecycle(run);
  expectToFail(() => checkCensus(r),
    "with the break shedding four pieces instead of fourteen the census " +
    "test should fail; it passed");
});

/* ------------------------------------------------------------------ */

function checkSound(r) {
  assert.deepEqual(r.recipes, ["glass-break", "glass-crack"],
    "there has to be a recipe for each of them, because cue() on a name " +
    "AUDIO_RECIPES does not have is silence that nothing reports; it has " +
    JSON.stringify(r.recipes));
  assert.equal(r.crackCues, 1,
    "the first step cracks ONCE; it cued " + r.crackCues + " times");
  assert.equal(r.breakCues, 1,
    "and the second one breaks once; it cued " + r.breakCues + " times");
  assert.equal(r.shieldCues, 1,
    "and neither of them borrows `shield-break`. That one belongs to the " +
    "BOTTLE and is deliberately the loudest thing in this character's " +
    "block; a pane going is a smaller event and must not compete with it, " +
    "so across a whole life -- one bottle, one crack, one break -- " +
    "`shield-break` should sound exactly once. It sounded " + r.shieldCues);
}

test("a pane cracks and a pane breaks, and neither one is the bottle", async () => {
  const run = await arena(COBEUS, REESE);
  checkSound(lifecycle(run));
});

test("negative control: a pane that borrows the bottle's break fails the sound test", async () => {
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "  cue('glass-break', { slot: slot, x: x });",
    "  cue('shield-break', { slot: slot, x: x });") });
  const r = lifecycle(run);
  expectToFail(() => checkSound(r),
    "with the pane reusing the bottle's cue the sound test should fail; " +
    "it passed");
});

/* ------------------------------------------------------------------ */

function checkPicture(r) {
  const b0 = beat(r, 0), bm1 = beat(r, -1);
  assert.ok(bm1 && bm1.rects > 0,
    "precondition: the frame before the step should still be drawing a pane");
  assert.ok(b0, "precondition: the break's first painted frame should exist");
  /* The pane's own footprint, told apart from the debris by its SIZE: the
     slivers born in the same frame are one and two pixels and three of them
     are white too. */
  const foot = b0.ops.filter(function (o) { return o.w === r.w && o.h === r.h; });
  assert.equal(foot.length, 1,
    "the first painted frame of a break is ONE rectangle the size of the " +
    "pane, not a ring and not a shower: the exact footprint you have been " +
    "walking around for four seconds, lighting up as it gives. It painted " +
    foot.length + " rectangles " + r.w + " by " + r.h);
  assert.equal(foot[0].c, "#ffffff",
    "and it is white -- the pane going bright is the whole read, and the " +
    "pale it fades to starts on the NEXT beat; it was " + foot[0].c);
  assert.equal(foot[0].a, 1,
    "at full alpha, for exactly that one frame; it was " + foot[0].a);
  const wide = b0.ops.filter(function (o) { return o.w > r.w; });
  assert.equal(wide.length, 0,
    "and nothing on that frame is WIDER than the pane was -- a break that " +
    "opens bigger than the thing it came from is the old ring's mistake, " +
    "which was drawn bigger than its own radius. " + wide.length +
    " rectangles overhung it");
  assert.ok(r.peak <= 40,
    "and the whole picture has to stay cheap -- the rainbow's burst peaks " +
    "at 497 rectangles in a single frame and this is a floor hazard that " +
    "can be on screen three at a time. It peaked at " + r.peak);
  assert.ok(r.peak >= 20,
    "and it has to be a picture at all, which is the defect this file " +
    "exists for: before 2.83 the pane was simply gone on the next frame " +
    "with nothing drawn. Its busiest frame had " + r.peak + " rectangles");
}

test("the break opens with the pane's own footprint and stays a tenth of the prism's cost", async () => {
  const run = await arena(COBEUS, REESE);
  checkPicture(lifecycle(run));
});

test("negative control: a break that opens at half the pane's width fails the picture test", async () => {
  /* Half a footprint is the version that looks like a spark rather than
     like the thing you were walking around, and it is one character. */
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "          const hw = (W >> 1) + b * 2;",
    "          const hw = (W >> 2) + b * 2;") });
  const r = lifecycle(run);
  expectToFail(() => checkPicture(r),
    "with the break opening at half width the picture test should fail; " +
    "it passed");
});

/* ------------------------------------------------------------------ */

/* Two panes, broken at two different points on the battle clock, at whatever
   x each one lands at -- and only the `splinter` is recorded, normalized onto
   its own centre. The slivers are deliberately left out: their spawn jitter
   is one draw off rand() inside addEffect's `if (s)` guard, which is the
   established exception and is not per-frame. What this asks is whether the
   PANE's own animation is a function of the effect's age and nothing else. */
const twice = (run) => JSON.parse(run(`(function () {
  ${RECORDER}
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });

  function once(warm) {
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 0; me.mana = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1; me.specialSpawned = false;
    me.x = main.x + 30; me.y = main.y;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.stocks = 99; foe.eliminated = false; foe.health = 4000; foe.hasHit = true;
    foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
    foe.x = main.x + main.w - 12; foe.invuln = 9999;
    var w;
    for (w = 0; w < warm; w++) {
      me.hitstop = 0; me.mana = 999;
      netplay.framePads = [bitsToPad(0), bitsToPad(0)];
      step();
    }
    var bornAt = -1, shots = [], i;
    for (i = 0; i < 145; i++) {
      me.hitstop = 0; me.mana = 999;
      var g = projectiles.filter(function (q) {
        return q.constructor.name === 'Glass' && !q.dead; })[0];
      if (g && bornAt < 0) bornAt = i;
      var want = bornAt >= 0 && (i === bornAt + 20 || i === bornAt + 70);
      if (g && want) {
        foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0; foe.setState('idle');
        foe.x = g.x; foe.y = main.y; foe.vx = 0; foe.vy = 0; foe.grounded = true;
      } else {
        foe.x = main.x + main.w - 12; foe.invuln = 9999;
      }
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
      step();
      if (bornAt >= 0 && i >= bornAt + 70 && i <= bornAt + 88) {
        var sp = effects.filter(function (e) { return e.kind === 'splinter'; })[0];
        var ops = [];
        if (sp) {
          // Mutate the array in place -- never reassign it -- so that only the
          // pane's own animation is recorded and the jittered debris is not.
          var saved = effects.slice(), q;
          effects.length = 0; effects.push(sp);
          var r = REC(); drawEffects(r);
          effects.length = 0;
          for (q = 0; q < saved.length; q++) effects.push(saved[q]);
          var cx = Math.round(sp.x), cy = Math.round(sp.y);
          ops = r.ops.map(function (o) {
            return [o.x - cx, o.y - cy, o.w, o.h, o.c, o.a].join(','); });
        }
        shots.push(ops.join('|'));
      }
    }
    return { at: warm, shots: shots };
  }

  netplay.active = true;
  var a = once(0);
  var b = once(37);
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ a: a, b: b });
})()`));

function checkSameTwice(r) {
  assert.ok(r.a.shots.length === 19 && r.b.shots.length === 19,
    "precondition: both breaks should have been recorded for nineteen " +
    "frames; got " + r.a.shots.length + " and " + r.b.shots.length);
  assert.ok(r.a.shots.some(function (s) { return s.length > 0; }),
    "precondition: the first break should have painted something at all");
  for (let i = 0; i < r.a.shots.length; i++) {
    assert.equal(r.b.shots[i], r.a.shots[i],
      "IT IS THE SAME BREAK EVERY TIME. Two panes broken thirty-seven " +
      "frames apart on the battle clock have to paint the identical " +
      "rectangles, because the whole animation is a function of the " +
      "effect's own age and constants -- the same contract the rainbow's " +
      "burst holds, and the reason a rollback can replay the frame a pane " +
      "died on without the screen changing. They differed on beat " +
      (i - 1) + ":\n  first  " + r.a.shots[i] + "\n  second " + r.b.shots[i]);
  }
}

test("the same break paints the same rectangles whenever it happens", async () => {
  const run = await arena(COBEUS, REESE);
  checkSameTwice(twice(run));
});

test("negative control: a break that wobbles frame to frame fails the sameness test", async () => {
  /* One term off Math.random in the alpha, which is exactly the kind of
     "life" somebody adds to an animation without noticing that effects are
     drawn during a rollback replay and the AI draws from the same stream. */
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "          g.globalAlpha = b === 0 ? 1 : 0.9 - (b - 1) * 0.2;",
    "          g.globalAlpha = b === 0 ? 1 : 0.9 - (b - 1) * 0.2 - Math.random() * 0.3;") });
  const r = twice(run);
  expectToFail(() => checkSameTwice(r),
    "with a random term in the break the sameness test should fail; it passed");
});

/* ------------------------------------------------------------------ */

/* A pane born ON A BODY. The bottle breaks on the first thing it reaches, so
   a pane thrown at somebody standing close is born at chest height and never
   touches the floor -- and debris skidding along an invisible plane twelve
   pixels up is the one way this animation can look broken. The victim is
   hovered at the pane's own height so that his hurtbox can reach it twice. */
const midair = (run) => JSON.parse(run(`(function () {
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 9999; me.mana = 999; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grounded = true; me.facing = 1; me.specialSpawned = false;
  me.x = main.x + 40; me.y = main.y;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 99; foe.eliminated = false; foe.health = 4000; foe.hasHit = true;
  foe.vx = 0; foe.vy = 0; foe.invuln = 0;
  foe.x = main.x + 52; foe.y = main.y; foe.grounded = true;

  var bornAt = -1, bornY = null, bites = [], snap = null, low = 0;
  netplay.active = true;
  for (var i = 0; i < 90; i++) {
    me.hitstop = 0; me.mana = 999;
    var g = projectiles.filter(function (q) {
      return q.constructor.name === 'Glass' && !q.dead; })[0];
    if (g && bornAt < 0) { bornAt = i; bornY = g.y; }
    if (g) {
      foe.invuln = 0; foe.hitstun = 0; foe.hitstop = 0; foe.setState('idle');
      foe.x = g.x; foe.y = g.y; foe.vy = 0; foe.vx = 0; foe.grounded = false;
    } else if (bornAt < 0) {
      foe.x = main.x + 52; foe.y = main.y; foe.grounded = true;
    }
    var h0 = foe.health;
    netplay.framePads = [bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0), bitsToPad(0)];
    step();
    if (foe.health < h0 - 0.0001) bites.push(i - bornAt);
    for (var q = 0; q < effects.length; q++) {
      var e = effects[q];
      if (e.kind === 'sliver' && e.spec != null && e.y > e.spec + 0.001) low++;
    }
    if (bites.length >= 3 && i === bornAt + 44) {
      snap = effects.filter(function (e) { return e.kind === 'sliver'; })
        .map(function (e) { return { floor: e.spec, y: +e.y.toFixed(3) }; });
    }
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ bornAt: bornAt, bornY: bornY, bites: bites,
    floorY: main.y, below: low, slivers: snap || [],
    tops: platformsNow().map(function (p) { return p.y; }) });
})()`));

function checkMidair(r) {
  assert.ok(r.bornAt >= 0, "precondition: the bottle should have left a pane");
  assert.ok(r.bornY < r.floorY - 3,
    "precondition: THIS pane has to be one born in mid-air, which is what " +
    "most of them are -- it broke on a chest, not on the floor. It was " +
    "born at " + r.bornY + " and the floor is " + r.floorY);
  assert.equal(r.slivers.length, 14,
    "precondition: fourteen slivers should still be in the air to look at; " +
    "there were " + r.slivers.length);
  for (const s of r.slivers) {
    assert.ok(r.tops.indexOf(s.floor) >= 0,
      "EVERY SLIVER FALLS TO A REAL FLOOR. This one is heading for " +
      s.floor + ", which is not the top of any platform on this stage (" +
      JSON.stringify(r.tops) + ") -- so it would skid along a plane that " +
      "is not there. Houston's milk looks the surface up for exactly this " +
      "reason and the bottle never did");
    assert.notEqual(s.floor, r.bornY,
      "and it must not be the height the PANE was born at (" + r.bornY +
      "), which is the trap: the pane copies the bottle's y, so debris " +
      "that inherits it lands on a chest that has walked away");
  }
  assert.equal(r.below, 0,
    "and none of them is ever drawn below the floor it found; " + r.below +
    " sliver-frames were under it");
}

test("the glass falls to the floor, not to the height it broke at", async () => {
  const run = await arena(COBEUS, REESE);
  checkMidair(midair(run));
});

test("negative control: debris that inherits the pane's own height fails the floor test", async () => {
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "                        SLIVER_INK[i % SLIVER_INK.length], i + 1, floor);",
    "                        SLIVER_INK[i % SLIVER_INK.length], i + 1, y);") });
  const r = midair(run);
  expectToFail(() => checkMidair(r),
    "with the debris inheriting the pane's own height the floor test " +
    "should fail; it passed");
});

/* ------------------------------------------------------------------ */

/* The side door. resolveCombat's catching loop kills a projectile outright,
   whatever it had left -- so without struck() a pane eaten by a mouth or
   shredded by a mower would vanish with nothing drawn, which is the exact
   defect the break exists to fix coming back in by another route.
   Cobeus against Cobeus, because the loop skips a shot you own. */
const eaten = (run) => JSON.parse(run(`(function () {
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });

  function stage(settle) {
    projectiles.length = 0; effects.length = 0;
    me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
    me.landLag = 0; me.invuln = 9999; me.mana = 999; me.vx = 0; me.vy = 0;
    me.grabbing = -1; me.grounded = true; me.facing = 1; me.health = 50;
    me.specialSpawned = false; me.fat = 0; me.bedTimer = 0; me.chargeTimer = 0;
    me.x = main.x + 60; me.y = main.y;
    foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
    foe.stocks = 99; foe.eliminated = false; foe.health = 1000; foe.hasHit = true;
    foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y; foe.invuln = 9999;
    foe.mana = 999; foe.specialSpawned = false; foe.facing = -1;
    foe.x = main.x + 130;
    var pane = null;
    for (var i = 0; i < 90; i++) {
      me.hitstop = 0; foe.hitstop = 0; me.mana = 999; foe.mana = 999;
      me.x = main.x + 60;
      netplay.framePads = [bitsToPad(0), bitsToPad(i === 0 ? ${SP_NEUTRAL} : 0)];
      step();
      var g = projectiles.filter(function (q) {
        return q.constructor.name === 'Glass' && !q.dead; })[0];
      if (g) pane = g;
    }
    if (settle && pane) { pane.hits--; pane.rearm = pane.spec.rearm; }
    return pane;
  }

  function open(settle) {
    var pane = stage(settle);
    if (!pane) return null;
    var px = pane.x, py = pane.y;
    me.x = px; me.y = py; me.grounded = true; me.setState('idle');
    me.timer = 0; me.hitstun = 0; me.attackFrame = 0; me.specialSpawned = false;
    effects.length = 0;
    var oldCue = cue, cues = [], peakSliver = 0, peakSplinter = 0;
    cue = function (nm, o) { cues.push(String(nm)); return oldCue(nm, o); };
    for (var i = 0; i < 24; i++) {
      me.hitstop = 0; me.mana = 999; me.x = px; me.y = py; me.grounded = true;
      foe.x = main.x + 130; foe.invuln = 9999;
      netplay.framePads = [bitsToPad(i === 0 ? ${SP_UP} : 0), bitsToPad(0)];
      step();
      var sl = 0, sp = 0;
      for (var q = 0; q < effects.length; q++) {
        if (effects[q].kind === 'sliver') sl++;
        if (effects[q].kind === 'splinter') sp++;
      }
      if (sl > peakSliver) peakSliver = sl;
      if (sp > peakSplinter) peakSplinter = sp;
    }
    cue = oldCue;
    var left = projectiles.filter(function (q) {
      return q.constructor.name === 'Glass' && !q.dead; })[0];
    return { survived: left ? 1 : 0, slivers: peakSliver,
             splinters: peakSplinter,
             breaks: cues.filter(function (c) { return c === 'glass-break'; }).length };
  }

  netplay.active = true;
  var armed = open(false);
  var settling = open(true);
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify({ armed: armed, settling: settling });
})()`));

function checkEaten(r) {
  assert.ok(r.armed && r.settling, "precondition: both panes should have been staged");
  assert.equal(r.armed.survived, 0,
    "an open mouth eats an ARMED pane -- it is a hitbox, so it is food; " +
    "the pane was still there afterwards");
  assert.equal(r.armed.splinters, 1,
    "AND IT PLAYS THE WHOLE BREAK ON THE WAY OUT. Being eaten is not " +
    "stepping in it, so whatever the pane had left it goes for good, and " +
    "what must not happen is what happened before struck() existed: the " +
    "pane simply gone, with nothing drawn. It spawned " + r.armed.splinters +
    " splinters");
  assert.equal(r.armed.slivers, 14,
    "and the full fourteen slivers, not a crack's four; it threw " +
    r.armed.slivers);
  assert.equal(r.armed.breaks, 1,
    "and it sounds once; it cued " + r.armed.breaks + " times");
  assert.equal(r.settling.survived, 1,
    "and a SETTLING pane is not food at all. resolveCombat's catching loop " +
    "asks live() before anything else, and a pane in its thirty frames is " +
    "not a hitbox -- a mouth opened over one has nothing to catch. It was " +
    "eaten anyway");
  assert.equal(r.settling.splinters, 0,
    "so nothing breaks and nothing is drawn over it; it spawned " +
    r.settling.splinters + " splinters");
}

test("a pane eaten by a mouth plays the whole break, and a settling one is not food", async () => {
  const run = await arena(COBEUS, COBEUS);
  checkEaten(eaten(run));
});

test("negative control: a pane that is eaten silently fails the eaten test", async () => {
  /* struck() with its animation taken out is precisely the shape of the bug
     this whole item exists to fix, arriving through a different door: the
     pane is gone on the next frame and nothing at all is drawn. */
  const run = await arena(COBEUS, COBEUS, { engine: sabotage(
    "    this.hits = 0;\n    this.dead = true;",
    "    this.hits = 0;\n    this.dead = true;\n    return;") });
  const r = eaten(run);
  expectToFail(() => checkEaten(r),
    "with an eaten pane vanishing quietly the eaten test should fail; " +
    "it passed");
});


/* =====================================================================
   7. THE TWO METHODS AGREE ABOUT DYING

   shatter() owns its own `dead`; struck() did not, and left it to the two
   callers in resolveCombat, which both assign it on the very next line. So
   nothing was broken and nothing could be seen -- which is exactly the shape
   of a trap for the next caller, and this file's own rule about burst and
   shatter is that each shot decides its own death.

   What it costs if somebody follows that rule and omits the assignment,
   measured: the pane comes back dead false, hits 0, live TRUE -- it has
   played its entire break and is still a hitbox -- and the next shatter()
   takes hits to MINUS ONE, falls through to the break branch, and plays a
   second full break, two splinters and two cues off one pane.
   ===================================================================== */

const struckPane = (run) => JSON.parse(run(`(function () {
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var gs = ROSTER.cobeus.specials.neutral.glass;
  var fake = { spec: { glass: gs }, owner: fighters[0],
               x: main.x + 100, y: main.y };
  effects.length = 0;
  var g = new Glass(fake);
  var fresh = { dead: g.dead, hits: g.hits, live: g.live() };
  g.struck();
  var after = { dead: g.dead, hits: g.hits, live: g.live() };
  var splintersOnce = effects.filter(function (e) { return e.kind === 'splinter'; }).length;
  /* A caller that did not know it had to finish the job. */
  g.shatter();
  var splintersTwice = effects.filter(function (e) { return e.kind === 'splinter'; }).length;
  return JSON.stringify({ fresh: fresh, after: after, hitsAfterSecond: g.hits,
    splintersOnce: splintersOnce, splintersTwice: splintersTwice });
})()`));

function checkStruckDies(r) {
  assert.equal(r.fresh.dead, false, "precondition: a fresh pane is alive");
  assert.equal(r.fresh.live, true, "precondition: and armed");
  assert.equal(r.after.dead, true,
    "A PANE THAT HAS PLAYED ITS BREAK IS DEAD, and it has to say so itself. " +
    "struck() is the eaten-or-shredded path: it spends the whole budget and " +
    "plays the whole break, so a pane that comes back from it reporting " +
    "dead " + r.after.dead + " is a pane that has been destroyed on screen " +
    "and is still a hitbox in the simulation");
  assert.equal(r.after.hits, 0, "and it has nothing left to spend");
  assert.equal(r.splintersOnce, 1,
    "precondition: being struck throws exactly one splinter");
  assert.equal(r.splintersTwice, r.splintersOnce,
    "AND IT BREAKS ONCE. A second call on a pane that has already broken has " +
    "to do nothing at all; this one threw " +
    (r.splintersTwice - r.splintersOnce) + " more splinters, which is the " +
    "same pane exploding twice");
  assert.ok(r.hitsAfterSecond >= 0,
    "and its budget never goes negative; it read " + r.hitsAfterSecond);
}

test("a pane that has been eaten is dead, and says so itself", async () => {
  const run = await arena(COBEUS, REESE);
  checkStruckDies(struckPane(run));
});

test("negative control: struck() leaving `dead` to its caller fails the two-methods test", async () => {
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "    this.hits = 0;\n    this.dead = true;",
    "    this.hits = 0;") });
  expectToFail(() => checkStruckDies(struckPane(run)),
    "with struck() leaving `dead` to its caller the two-methods test should " +
    "fail; it passed");
});

/* =====================================================================
   8. NOUGHT IS A NUMBER

   `rearm` is the lever this release names for walking the two-bite buff back,
   and the whole argument for thirty rests on what NOUGHT would do -- a pane
   that re-arms instantly takes both its bites in one overlap frame, which is
   five damage for one step and not a budget at all. So nought has to be a
   value somebody can actually write.

   It was not. `gs.hits || 1` and `this.spec.rearm || 30` both read zero as
   absent and silently substituted the default, so a designer or a probe that
   wrote `rearm: 0`, measured no change and concluded the gap does nothing was
   measuring the shipped thirty. It caught a verifier writing this very
   control. The test is the one that stops a silent default being mistaken
   for a measurement.
   ===================================================================== */

const zeroIsAValue = (run) => JSON.parse(run(`(function () {
  var main = STAGE.platforms.find(function (p) { return p.main; });
  var gs = ROSTER.cobeus.specials.neutral.glass;
  var keptH = gs.hits, keptR = gs.rearm;
  var fake = { spec: { glass: gs }, owner: fighters[0],
               x: main.x + 100, y: main.y };
  gs.hits = 0; gs.rearm = 0;
  var zero = new Glass(fake);
  var askedZero = zero.hits;
  zero.hits = 2;
  zero.shatter();
  var rearmWhenZero = zero.rearm;
  /* And absent still means the default, which is the other half of the rule. */
  delete gs.hits; delete gs.rearm;
  var bare = new Glass(fake);
  var askedNothing = bare.hits;
  bare.hits = 2;
  bare.shatter();
  var rearmWhenAbsent = bare.rearm;
  gs.hits = keptH; gs.rearm = keptR;
  return JSON.stringify({ askedZero: askedZero, rearmWhenZero: rearmWhenZero,
    askedNothing: askedNothing, rearmWhenAbsent: rearmWhenAbsent,
    shippedHits: keptH, shippedRearm: keptR });
})()`));

function checkZeroIsAValue(r) {
  assert.equal(r.askedZero, 0,
    "A BUDGET OF NOUGHT HAS TO BE A BUDGET OF NOUGHT. Asked for hits 0 the " +
    "pane answered " + r.askedZero + ", which is the default wearing the " +
    "tuning value's clothes -- and the next person to reach for it will " +
    "measure the shipped number and write down that their change did nothing");
  assert.equal(r.rearmWhenZero, 0,
    "and a gap of nought is a gap of nought; asked for rearm 0 the pane sat " +
    "out " + r.rearmWhenZero + " frames. This is the lever named for walking " +
    "the two-bite buff back, so a probe that cannot set it cannot measure it");
  assert.equal(r.askedNothing, 1,
    "and ABSENT still means one, which is the half of the rule that keeps " +
    "every other caller working; it read " + r.askedNothing);
  assert.equal(r.rearmWhenAbsent, 30,
    "and an absent gap is still thirty; it read " + r.rearmWhenAbsent);
  assert.equal(r.shippedHits, 2, "precondition: the shipped budget is two");
  assert.equal(r.shippedRearm, 30, "precondition: and the shipped gap thirty");
}

test("a pane can be tuned to nought, on both of its two numbers", async () => {
  const run = await arena(COBEUS, REESE);
  checkZeroIsAValue(zeroIsAValue(run));
});

test("negative control: an || default swallows a deliberate nought", async () => {
  const run = await arena(COBEUS, REESE, { engine: sabotageBoth(
    "    this.hits = gs.hits == null ? 1 : gs.hits;",
    "    this.hits = gs.hits || 1;",
    "      this.rearm = this.spec.rearm == null ? 30 : this.spec.rearm;",
    "      this.rearm = this.spec.rearm || 30;") });
  expectToFail(() => checkZeroIsAValue(zeroIsAValue(run)),
    "with || defaults the nought test should fail; it passed");
});


/* =====================================================================
   9. THE PANE YOU CANNOT STAND ON IS STILL A PANE YOU CAN SEE

   The thirty frames between the two bites are the only state that cannot
   hurt you, and the design is deliberate: no sprite, just glints lying flat
   on the floor, because drawing a solid object where there is no hitbox is
   the lie this move's comments have argued against for three releases.

   What it shipped as was nine pixels of #c9e7e8 at HALF alpha and nothing
   else, and pale-on-pale is nothing: on a light stage the settling pane
   painted nothing a player could see. A patch of floor went empty for half a
   second and then had glass on it again, which reads as the pane vanishing
   and coming back -- the exact failure the break animation was added to
   kill, arriving through the other door.

   So the property is not an alpha or a pixel count, it is CONTRAST, and it
   has to hold on both tones at once: the look paints a pale ink AND a dark
   ink, so no single backdrop can swallow all of it. A test that asserted
   "nine rects at 0.5" would have passed the whole time.
   ===================================================================== */

const settlingLook = (run) => JSON.parse(run(`(function () {
  ${RECORDER}
  var gs = ROSTER.cobeus.specials.neutral.glass;
  var fake = { spec: { glass: gs }, owner: fighters[0], x: 60, y: 60 };
  function look(state) {
    var q = new Glass(fake);
    if (state === 'settling') { q.hits = 1; q.rearm = 15; }
    if (state === 'cracked')  { q.hits = 1; q.rearm = 0; }
    var g = REC();
    q.draw(g);
    var rects = g.ops.filter(function (o) { return !o.img; });
    var sprites = g.ops.filter(function (o) { return o.img; }).length;
    var inks = {};
    rects.forEach(function (o) { inks[o.c] = Math.max(inks[o.c] || 0, o.a); });
    var wide = rects.filter(function (o) { return o.w > 2 || o.h > 2; }).length;
    return { rects: rects.length, sprites: sprites, inks: inks, wide: wide,
             alphaMax: rects.reduce(function (a, o) { return Math.max(a, o.a); }, 0) };
  }
  return JSON.stringify({ whole: look('whole'), settling: look('settling'),
                          cracked: look('cracked') });
})()`));

/* Relative luminance, and a crude one on purpose -- the question is only
   whether an ink is on the pale side or the dark side of the backdrops this
   game actually uses, and every stage in it is either near-white sky or
   near-black night. */
function lum(css) {
  const h = css.replace("#", "");
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

function checkSettlingIsVisible(r) {
  assert.equal(r.settling.sprites, 0,
    "precondition: a settling pane draws no solid object -- that is the " +
    "whole read, and it is not what this test is about");
  assert.equal(r.settling.wide, 0,
    "precondition: and nothing it paints is bigger than a pixel or two");
  assert.ok(r.settling.rects > 0, "precondition: it paints something");

  const inks = Object.keys(r.settling.inks);
  const pale = inks.filter((c) => lum(c) > 0.6);
  const dark = inks.filter((c) => lum(c) < 0.25);
  assert.ok(pale.length > 0 && dark.length > 0,
    "A SETTLING PANE HAS TO BE VISIBLE ON EVERY BACKDROP, and the only way " +
    "one pixel of art manages that is by carrying both tones: a pale ink for " +
    "the night stages and a dark one for the pale ones. It painted " +
    JSON.stringify(inks) + " -- pale " + JSON.stringify(pale) + ", dark " +
    JSON.stringify(dark) + ". With one tone only, half the stages in the game " +
    "show a patch of floor going empty for thirty frames and then having " +
    "glass on it again, which is the pane vanishing and coming back");

  const strongest = Math.max(...inks.map((c) => r.settling.inks[c]));
  assert.ok(strongest >= 0.7,
    "and it is painted firmly enough to be seen at all; the strongest ink " +
    "on it is at alpha " + strongest + ". Half alpha was chosen to say 'not " +
    "solid', but what says that here is that there is no sprite and the " +
    "glints lie flat -- the alpha was only ever costing legibility");

  /* And the state it is NOT: the two that can hurt you still draw the thing. */
  assert.equal(r.whole.sprites, 1, "a whole pane still draws its sprite");
  assert.equal(r.cracked.sprites, 1, "and so does a cracked one");
}

test("a settling pane can be seen on a light stage and on a dark one", async () => {
  const run = await arena(COBEUS, REESE);
  checkSettlingIsVisible(settlingLook(run));
});

test("negative control: pale glints alone vanish on a pale stage", async () => {
  /* What shipped: one tone, half alpha. Every other assertion here passes
     against it -- no sprite, nothing wide, nine rects -- which is exactly
     why the property had to be written as contrast and not as a census. */
  const run = await arena(COBEUS, REESE, { engine: sabotage(
    "    if (settling) {\n      // The second tone.",
    "    if (false) {\n      // The second tone.") });
  expectToFail(() => checkSettlingIsVisible(settlingLook(run)),
    "with the settling pane painted in one tone the visibility test should " +
    "fail; it passed");
});
