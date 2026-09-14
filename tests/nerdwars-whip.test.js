/* THE WHIP, AS A THING YOU CAN SEE.
 *
 * Squalls' up special had forty pixels of hitbox and no picture at all until
 * 2.65: he swung at thin air, and the one distance the move is about -- the
 * last eight pixels, where it hits for double -- was something a player could
 * only learn by being hit by it. drawWhip puts a bullwhip in his hand now:
 * coiled at his hip through the twelve startup frames, cracking out to full
 * stretch across the six active ones, sagging and gathering back in over the
 * twenty-two of recovery.
 *
 * What the move DOES is pinned next door in nerdwars-squalls.test.js -- the
 * damage either side of the sweet spot, the launch angle, the mana. Nothing
 * here reads a health bar. This file measures the PICTURE, because a picture
 * laid over a hitbox has its own ways of being wrong and a test that only
 * watches damage cannot see any of them:
 *
 *   IT CAN COME OUT OVER THE WRONG MOVE. That bug shipped this month on
 *   another character -- Christian's axe drew itself over every special he
 *   had, because the guard asked whether he OWNED an axe rather than whether
 *   he was SWINGING one. Both of the whip's guards are exercised below, by
 *   driving all four of Squalls' specials and his jab, and somebody else's up
 *   special, through the real input path and looking at what got painted.
 *
 *   IT CAN LIE ABOUT THE RANGE. The whole of this move is standing at tip
 *   range. Art drawn long teaches a reach that whiffs; art drawn short teaches
 *   a player to walk in and give the sweet spot away, which on a spacing move
 *   is the worst thing the drawing could do. The drawing reads `ox`, `w` and
 *   `sweet.from` off the move rather than copying them down, and the test
 *   below compares what was painted against the box the engine actually built
 *   on that same frame.
 *
 *   IT CAN GO MISSING FOR A FRAME. There was exactly one -- attackFrame 0,
 *   the frame the move starts on, before updateAttack has counted it -- and on
 *   it he stood in the special state holding nothing at all. It is clamped
 *   now, and pinned here so that it stays clamped.
 *
 *   IT CAN FAIL TO MIRROR. Facing left it has to reach left by the same
 *   amount; a whip that forgets `facing` still looks like a whip on one half
 *   of the screen and like a bug on the other.
 *
 * THE CANVAS STUB CANNOT SEE ANY OF THIS. The context the other files hand
 * the engine is a Proxy of no-op functions and it throws every fillRect away.
 * The probe below builds a RECORDING context instead -- fillStyle remembered,
 * every fillRect kept along with the color that was live when it was called --
 * which is the whole of the canvas API this drawing uses.
 *
 * Everything is driven through the real input path, as the rest of the suite
 * does, and every test has a NEGATIVE CONTROL beside it: the same checker run
 * against a copy of the engine with ONE line changed in memory, and the check
 * is that the same assertions then fail. The mutated copies live in a string
 * and a fresh vm and are never written anywhere.
 *
 * These load the engine source rather than going through NerdWars.fighters,
 * as the squalls and platforms files do, because none of it is reachable from
 * outside: ROSTER, drawWhip and hitbox() are all internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

/* Each vm gets its own Math.random stream. Every harness in this suite hands
   the sandbox the HOST's Math, so without this they all draw from one shared
   sequence -- and node --test runs files concurrently, which makes the
   interleaving, and therefore any test that averages over AI behavior,
   different on every run. Math remains the prototype, so everything else on
   it still works. */
let __seedCounter = 0;
function seededMath() {
  let s = (0x9e3779b9 ^ (++__seedCounter * 2654435761)) >>> 0 || 1;
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

/* Stores what is written to it, unlike a discard-everything stub: the engine
   reads back properties it sets (fillStyle, globalAlpha), and a test cannot
   install a spy on a context that throws writes away. This is the stub the
   BATTLE runs on; the whip is drawn onto a recorder built inside the probe. */
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

/* Takes the engine SOURCE rather than always reading it off disk, so a
   negative control can boot a mutated copy in a fresh vm without that copy
   ever touching the filesystem.

   The globals list is the one every file in this suite uses, and it is short
   on purpose: anything the engine reaches for that is not here throws at LOAD
   time, in every test at once, nowhere near the line that wanted it. */
async function bootEngine(engineSrc) {
  const view = stubCanvas(960, 540);
  const sandbox = {
    console, Math: seededMath(), JSON, Date, Promise, Object, Array, Map, Set, Number,
    String, Boolean, Error, DataView, ArrayBuffer, Uint8Array, Float32Array,
    Float64Array, isNaN, parseInt, parseFloat,
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
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(
    "var SPRITES=window.NERDWARS_ASSETS.SPRITES,TILES=window.NERDWARS_ASSETS.TILES," +
      "UI=window.NERDWARS_ASSETS.UI;", sandbox);
  vm.runInContext(engineSrc || readFileSync(ENGINE_PATH, "utf8"), sandbox,
                  { filename: "nerdwars.js" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return (src) => vm.runInContext(src, sandbox);
}

/* One line of the engine, changed in memory. Never written to disk, and
   never applied to the copy the real tests run against.

   Both halves are asserted. A needle that is not there, or is there twice,
   makes a control that silently mutates nothing or mutates the wrong thing --
   which is exactly the failure a negative control exists to rule out. The
   whip's two guards are word for word the axe's two guards, which is why the
   control that removes one of them anchors on the line above it as well. */
function sabotage(needle, replacement) {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const at = src.indexOf(needle);
  assert.ok(at >= 0, "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(src.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return src.slice(0, at) + replacement + src.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   and it has to throw an assertion. Anything else thrown is a broken checker
   rather than a failed test, and is let through so it shows up as itself. */
function expectToFail(check, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") return;
    throw e;
  }
  assert.fail(why);
}

/* Two fighters on a stage, past the 110 frames of spawn invulnerability.
   `a` and `b` are positions in ORDER. Both seats are CPUs, which costs
   nothing: the probe below hands both of them pads of its own, and a pad from
   netplay is what the fighter reads. */
async function arena(a, b, opts) {
  const o = opts || {};
  const run = await bootEngine(o.engine);
  run(`select.cursor=[${a},${b}]; twoPlayer=true; playerCount=2; humanCount=0;` +
      ` stagePick=${o.stage || 0}; startBattle();`);
  run("for (var i=0;i<130;i++) step();");
  return run;
}

/* The world put somewhere known, at the top of every measurement. Written as
   a string rather than as a helper because it runs INSIDE the vm, where the
   test has no functions of its own.

   `freezeFrames` is cleared deliberately rather than out of habit: a KO stops
   the whole simulation for about a dozen frames, and a measurement that began
   inside somebody else's freeze would spend its one press on a frame where
   nothing is listening and then record a dozen identical frames of nothing. */
const SETUP = `
  var me = fighters[0], foe = fighters[1];
  var main = STAGE.platforms.find(function (p) { return p.main; });
  projectiles.length = 0; effects.length = 0;
  freezeFrames = 0;
  me.setState('idle'); me.timer = 0; me.hitstun = 0; me.hitstop = 0;
  me.landLag = 0; me.invuln = 0; me.mana = 100; me.vx = 0; me.vy = 0;
  me.grabbing = -1; me.grabbedBy = -1; me.grounded = true; me.facing = 1;
  me.ultMeter = 999; me.x = main.x + 24; me.y = main.y; me.specialSpawned = false;
  me.dream = 0; me.wakeUp = false; me.health = 100;
  foe.setState('idle'); foe.timer = 0; foe.hitstun = 0; foe.hitstop = 0;
  foe.stocks = 3; foe.eliminated = false; foe.health = 100; foe.hasHit = true;
  foe.grounded = true; foe.vx = 0; foe.vy = 0; foe.y = main.y;
  foe.burn = 0; foe.poison = 0; foe.confused = 0; foe.drowsy = 0;
  foe.grabbing = -1; foe.grabbedBy = -1; foe.mana = 100;
  foe.x = main.x + main.w / 2;
  me.ultMeter = 999; me.mana = 999;`;

// The pad bits, as netplay packs them. ATTACK is the jab.
const ATTACK = 32, ULT = 256;
const SP_NEUTRAL = 512, SP_DOWN = 1024, SP_UP = 2048;

// Where each fighter sits in ORDER. Positions, not names, because that is
// what select.cursor takes.
const REESE = 4, SQUALLS = 8;

/* One press, and every rectangle the whip paints on every frame of whatever
   that press started.

   Each row is one frame of the move: how many rectangles were painted, how
   far FORWARD the furthest one reached, how far BEHIND him the furthest one
   went, where the nearest sweet-spot-colored pixel was, and what the engine's
   own hitbox() said on that same frame. Every distance is measured from the
   pixel his sprite is centered on and signed by the way he is facing, so the
   left-facing numbers can be laid straight on top of the right-facing ones --
   which is the whole of the mirror test.

   The hitbox is read here rather than derived from the spec because it is the
   thing the drawing has to agree with. A test that compared the art against
   `ox` and `w` and never asked the engine what box it built would still pass
   the day those two stopped meaning what the art assumes.

   His facing is re-imposed after every step rather than set once: a fighter
   is free to turn around, and what is being measured is the drawing at a
   known facing. The other man is made untouchable for a duller reason -- a
   connecting hit lands hitstop on the swinger, and a frame the engine skipped
   is a frame this would otherwise record twice as if it were two. */
const whipTrace = (run, bits, facing, seat) => {
  const pads = seat === 0
    ? `[bitsToPad(i === 0 ? ${bits} : 0), bitsToPad(0)]`
    : `[bitsToPad(0), bitsToPad(i === 0 ? ${bits} : 0)]`;
  return JSON.parse(run(`(function () {
  ${SETUP}
  var who = fighters[${seat}], other = fighters[${1 - seat}];
  who.facing = ${facing};
  // The recording context. Everything in this drawing is fillStyle and
  // fillRect, so this is all of the canvas it can ask for.
  var rects = [], sty = '#000';
  var rec = { globalAlpha: 1,
    get fillStyle() { return sty; }, set fillStyle(v) { sty = v; },
    fillRect: function (x, y, w, h) { rects.push([x, y, w, h, sty]); } };
  var rows = [], going = false;
  netplay.active = true;
  for (var i = 0; i < 320; i++) {
    who.hitstop = 0; who.mana = 999; who.ultMeter = 999; other.invuln = 999;
    netplay.framePads = ${pads};
    step();
    who.facing = ${facing};
    var moving = who.state === 'special' || who.state === 'attack' ||
                 who.state === 'ult';
    if (moving) going = true; else if (going) break;
    if (!moving) continue;
    rects.length = 0;
    drawWhip(rec, who);
    // Rounded the way the drawing rounds it, so the two agree about which
    // pixel column he is standing on.
    var ax = Math.round(who.x);
    var fwd = -999, back = -999, hotNear = 999, hot = 0;
    for (var j = 0; j < rects.length; j++) {
      // A rectangle covers the columns [x, x + w - 1]; its near and far edges
      // swap over when he is facing the other way.
      var lo = rects[j][0] - ax, hi = rects[j][0] + rects[j][2] - 1 - ax;
      var f = ${facing} > 0 ? hi : -lo, b = ${facing} > 0 ? -lo : hi;
      if (f > fwd) fwd = f;
      if (b > back) back = b;
      if (rects[j][4] === WHIP_HOT) {
        hot++;
        var nr = ${facing} > 0 ? lo : -hi;
        if (nr < hotNear) hotNear = nr;
      }
    }
    var h = who.hitbox();
    rows.push({ k: who.attackFrame, state: who.state, n: rects.length,
                fwd: fwd, back: back, hot: hot, hotNear: hotNear,
                near: h ? (${facing} > 0 ? h.box.x - ax : ax - h.box.x - h.box.w) : null,
                far: h ? (${facing} > 0 ? h.box.x + h.box.w - ax : ax - h.box.x) : null });
  }
  netplay.active = false; netplay.framePads = null;
  return JSON.stringify(rows);
})()`));
};

// The whip's own spec, and the other four moves that have to stay out of its way.
const whipSpec = (run) =>
  JSON.parse(run("JSON.stringify(ROSTER.squalls.specials.up)"));

/* =====================================================================
   IT ONLY COMES OUT FOR THE WHIP
   ===================================================================== */

/* Six casts through the real input path, and what each of them painted.
   Squalls throws the star, stands in the bakery, swings the whip, dreams up
   the dragon and jabs; Reese, who has an up special that is not a whip, casts
   his. Only one of those six is allowed to put a whip on the screen. */
const everyMove = (run) => ({
  whip: whipTrace(run, SP_UP, 1, 0),
  star: whipTrace(run, SP_NEUTRAL, 1, 0),
  bakery: whipTrace(run, SP_DOWN, 1, 0),
  dragon: whipTrace(run, ULT, 1, 0),
  jab: whipTrace(run, ATTACK, 1, 0),
  foeUp: whipTrace(run, SP_UP, 1, 1),
});

function checkOnlyForTheWhip(run, t) {
  const kinds = JSON.parse(run(`JSON.stringify({
    up: ROSTER.squalls.specials.up.kind,
    neutral: ROSTER.squalls.specials.neutral.kind,
    down: ROSTER.squalls.specials.down.kind,
    ult: ROSTER.squalls.ult.kind,
    foeUp: ROSTER.reese.specials.up.kind })`));
  assert.equal(kinds.up, "whip",
    "precondition: the whip is his UP special; that slot holds " + kinds.up);
  assert.notEqual(kinds.foeUp, "whip",
    "precondition: the other man's up special must not be a whip either -- he " +
    "is in this test to prove the drawing asks what the move IS and not " +
    "merely which slot it is in, and his up is a " + kinds.foeUp);

  assert.ok(t.whip.length > 0,
    "precondition: the whip should have been cast at all; no frame of it was " +
    "measured");
  const drew = t.whip.filter((r) => r.n > 0).length;
  assert.ok(drew > 0,
    "THE WHIP HAS TO BE DRAWN. It had forty pixels of hitbox and no art " +
    "whatsoever until 2.65, which is the state this whole file exists to " +
    "stop it going back to; not one rectangle came out across " +
    t.whip.length + " frames of it");

  /* And nothing else. This is the one that matters, and it is not a
     hypothetical: Christian's axe drew itself over his cookie, his frogs and
     his ult, because the guard asked whether he was holding an axe rather
     than whether he was swinging one, and it shipped. A whip over the bakery
     is the same bug wearing a different hat -- the move still works, the
     damage is still right, and the only thing wrong with it is that he is
     standing there daydreaming about bread with a bullwhip cracking out of
     his hip. */
  for (const [what, rows] of [["the star", t.star], ["the bakery", t.bakery],
                              ["the dragon", t.dragon], ["his jab", t.jab],
                              ["somebody else's up special", t.foeUp]]) {
    assert.ok(rows.length > 0,
      "precondition: " + what + " should have run at all; no frame of it was " +
      "measured, so this proves nothing");
    const painted = rows.reduce((a, r) => a + r.n, 0);
    assert.equal(painted, 0,
      "the whip must not be drawn over " + what + " -- drawWhip has to ask " +
      "whether he is SWINGING one, not whether he owns one; it painted " +
      painted + " rectangles across " + rows.length + " frames of it");
  }
}

test("the whip is drawn for the whip, and for nothing else he can do", async () => {
  const run = await arena(SQUALLS, REESE);
  checkOnlyForTheWhip(run, everyMove(run));
});

test("negative control: without the moveFor guard the whip draws over his other specials", async () => {
  /* Christian's axe bug, transplanted. The move-kind guard is left exactly as
     it is, so the whip still only belongs to a man whose up special is a
     whip -- what goes is the question of whether the special he is CASTING is
     that one. Squalls then swings a whip through the star and through the
     whole four seconds of the bakery.

     Anchored on the line above it because the whip's two guards are word for
     word the axe's two guards, and the moveFor line on its own matches twice. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "  if (!s || s.kind !== 'whip') return;\n" +
    "  if (f.moveFor('special') !== s) return;",
    "  if (!s || s.kind !== 'whip') return;\n" +
    "  if (false && f.moveFor('special') !== s) return;") });
  expectToFail(() => checkOnlyForTheWhip(run, everyMove(run)),
    "with the moveFor guard gone the exclusivity test should fail; it passed");
});

test("negative control: without the kind guard the whip draws over somebody else's up special", async () => {
  /* The other guard, and the reason a second character is in the sweep at
     all. Drop the question of what the move IS and the drawing is left asking
     only which SLOT it came out of, so every fighter on the roster with an up
     special grows a bullwhip -- Reese's dash cracks one out of his hip as he
     goes. Squalls himself looks perfectly correct throughout, which is why no
     amount of testing him alone would have caught it. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "  if (!s || s.kind !== 'whip') return;",
    "  if (!s) return;") });
  expectToFail(() => checkOnlyForTheWhip(run, everyMove(run)),
    "with the move-kind guard gone the exclusivity test should fail; it passed");
});

/* =====================================================================
   IT DOES NOT OVERSELL ITS RANGE
   ===================================================================== */

function checkWhipReach(s, rows) {
  const tip = s.ox + s.w;
  assert.equal(rows.length, s.startup + s.active + s.recovery,
    "precondition: the trace should cover the whole move (" + s.startup + " + " +
    s.active + " + " + s.recovery + " frames); it covered " + rows.length);

  /* The box the engine actually built, on the frames it was out. Asserted
     against the spec first so that everything below can be phrased in terms
     of `ox` and `w`: if these two ever stop agreeing, the reach assertions
     are comparing the art against a box that is not there. */
  const live = rows.filter((r) => r.far !== null);
  assert.equal(live.length, s.active,
    "precondition: the hitbox should be out for `active` frames (" + s.active +
    "); it was out for " + live.length);
  for (const r of live) {
    assert.equal(r.near, s.ox,
      "precondition: the box starts `ox` (" + s.ox + ") in front of him; on " +
      "frame " + r.k + " it started at " + r.near);
    assert.equal(r.far, tip,
      "precondition: and ends `ox` + `w` (" + tip + ") in front of him; on " +
      "frame " + r.k + " it ended at " + r.far);
  }

  /* A pixel of pad and a pixel of halo. Every rectangle in the dark pass is
     grown by one on all four sides to buy the whole whip a shadow, and the
     knot of halo at the tip reaches a pixel beyond that -- so two is what
     "the drawing stops where the box stops" comes out as when it is measured
     in painted pixels rather than in curve coordinates. */
  const GLOW = 2;
  for (const r of rows) {
    assert.ok(r.fwd <= tip + GLOW,
      "nothing may be painted past the end of the box (" + tip + ") by more " +
      "than " + GLOW + " pixels of glow: a whip drawn longer than it reaches " +
      "teaches a range that whiffs, and this is the move whose entire point " +
      "is knowing where the end of it is. Frame " + r.k + " reached " + r.fwd);
  }

  /* And the other way round, which is the likelier mistake and the worse one.
     Art that stops short of the box teaches a player to walk in until the
     picture touches somebody -- which is exactly where the sweet spot stops
     paying. It has to be out at full stretch for as long as the move is live. */
  const stretched = rows.filter((r) => r.fwd >= tip - 1);
  assert.ok(stretched.length >= s.active,
    "the whip has to actually REACH: it should stand at the end of its box (" +
    tip + ") for at least the " + s.active + " frames the box is out, and it " +
    "was there on " + stretched.length + " frames");
  const together = stretched.filter((r) => r.far !== null);
  assert.equal(together.length, s.active,
    "and be out there WHILE it can hit -- on EVERY one of the " + s.active +
    " frames the box is out, not all but one of them. The art used to run a " +
    "frame behind the box: on the first live frame the box reached the full " +
    tip + " while the lash was drawn less than thirty out, so it hit people " +
    "it had visibly not reached. " + together.length + " frames were at full " +
    "stretch while live");

  /* And the other half of that lie, which was the worse one. The whip used to
     stand at full stretch with its tip lit in the sweet-spot gold on the
     frame AFTER the last live one -- the picture at its most dangerous on a
     frame the move was already over. The gold is the only thing on screen
     saying where the double damage is, so it has no business appearing on a
     frame that cannot deal any. */
  for (const r of rows) {
    if (r.far !== null) continue;
    assert.equal(r.hot, 0,
      "the sweet-spot color is a promise that this frame can hit you for " +
      "double, so it must never be painted on a frame whose hitbox is gone. " +
      "Frame " + r.k + " painted " + r.hot + " pixels of it with no box out");
  }

  /* The sweet spot is colored, and the color is the only thing on screen that
     says where the double damage starts. resolveCombat measures that from the
     victim's near edge to his center, so the drawing colors by the same
     distance -- paint it by how far along the WHIP a pixel is instead and the
     bright part slides up and down as the whip bends, teaching a range that
     moves. */
  const hotFrames = rows.filter((r) => r.hot > 0);
  assert.ok(hotFrames.length > 0,
    "some frame has to paint the sweet spot in the sweet spot's own color, " +
    "or the last eight pixels are worth double and nothing says so");
  for (const r of hotFrames) {
    assert.ok(r.hotNear >= s.sweet.from,
      "and it must not light up nearer than `sweet.from` (" + s.sweet.from +
      "): a bright band that starts early teaches a player to stand where the " +
      "move pays single. Frame " + r.k + " lit up from " + r.hotNear);
  }
}

test("the drawn whip reaches the end of its hitbox and no further", async () => {
  const run = await arena(SQUALLS, REESE);
  checkWhipReach(whipSpec(run), whipTrace(run, SP_UP, 1, 0));
});

test("negative control: a whip painted past its box fails the reach test", async () => {
  /* The clamp is what holds the drawing to the hitbox -- the pose table's own
     far point is a pixel PAST the box, and every sample beyond the end is
     pulled back to it. Push those samples out instead and the art grows a
     tip that is twelve pixels of pure lie: it looks like it reaches, it
     whiffs, and nothing about the move has otherwise changed. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      if (fwd > s.reach) fwd = s.reach;",
    "      if (fwd > s.reach) fwd = s.reach + 12;") });
  expectToFail(() => checkWhipReach(whipSpec(run), whipTrace(run, SP_UP, 1, 0)),
    "with the art painted past its box the reach test should fail; it passed");
});

test("negative control: a whip drawn half as long as its box fails the reach test", async () => {
  /* The undersell, and it is the one that would survive a screenshot: a
     twenty-four pixel whip on a forty-four pixel box is a perfectly handsome
     whip. It just teaches everybody to walk twenty pixels too far in, which
     is where the sweet spot stops paying and the recovery starts hurting. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    near: s.ox, reach: s.ox + s.w, midY: s.oy,",
    "    near: s.ox, reach: s.ox + Math.round(s.w / 2), midY: s.oy,") });
  expectToFail(() => checkWhipReach(whipSpec(run), whipTrace(run, SP_UP, 1, 0)),
    "with the art drawn half the length of its box the reach test should " +
    "fail; it passed");
});

test("negative control: a sweet spot lit up early fails the reach test", async () => {
  /* The art keeps its length and moves only the bright band, fourteen pixels
     nearer than the hitbox pays out at. That is the regression this half of
     the test exists for and there is no other way to catch it: the whip
     reaches the right distance, hits for the right damage at the right
     distance, and quietly tells the player the good part starts somewhere it
     does not. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "    sweetFrom: (s.sweet && s.sweet.from) || s.ox + s.w,",
    "    sweetFrom: (s.sweet && s.sweet.from - 14) || s.ox + s.w,") });
  expectToFail(() => checkWhipReach(whipSpec(run), whipTrace(run, SP_UP, 1, 0)),
    "with the sweet spot lit up early the reach test should fail; it passed");
});

/* =====================================================================
   IT IS DRAWN ON EVERY FRAME OF THE MOVE
   ===================================================================== */

function checkDrawnEveryFrame(s, rows) {
  const total = s.startup + s.active + s.recovery;
  assert.equal(rows.length, total,
    "precondition: he should spend " + total + " frames in the special state; " +
    "he spent " + rows.length);
  assert.equal(rows[0].k, 0,
    "precondition: the first of them is attackFrame 0 -- the frame the move " +
    "starts on, before updateAttack has counted it -- and it is the frame " +
    "this test is really about; the trace started at " + rows[0].k);
  const seen = rows.map((r) => r.k).join(",");
  const want = rows.map((r, i) => i).join(",");
  assert.equal(seen, want,
    "precondition: and they should run straight through with none skipped; " +
    "they were " + seen);

  /* There must be no frame where he is mid-whip holding nothing. There was
     exactly one and it was at the front, where a player is looking straight
     at his hand: the pose table starts at 1, so frame 0 either had to be
     clamped onto the first authored pose or returned early, and returning
     early is a man winding up an invisible whip for a frame. */
  const blank = rows.filter((r) => r.n === 0).map((r) => r.k);
  assert.deepEqual(blank, [],
    "every frame he spends in this move has to have a whip in it -- there is " +
    "no frame of a swing where a bullwhip is allowed to not exist; nothing " +
    "was painted on frame(s) " + blank.join(", "));
}

test("there is no frame of the whip where his hand is empty", async () => {
  const run = await arena(SQUALLS, REESE);
  checkDrawnEveryFrame(whipSpec(run), whipTrace(run, SP_UP, 1, 0));
});

test("negative control: the frame-0 early return fails the every-frame test", async () => {
  /* The bug exactly as it was, put back in one line: rather than clamping the
     first frame onto the first authored pose, give up on it. Thirty-nine of
     the forty frames are untouched and look perfect, which is why this lived
     as long as it did -- one frame in sixty is not something anybody sees, it
     is something that makes the swing feel very slightly wrong. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "  const kf = k < 1 ? 1 : k;",
    "  if (k < 1) return;\n  const kf = k;") });
  expectToFail(() => checkDrawnEveryFrame(whipSpec(run), whipTrace(run, SP_UP, 1, 0)),
    "with frame 0 returning early the every-frame test should fail; it passed");
});

/* =====================================================================
   IT MIRRORS
   ===================================================================== */

function checkWhipMirrors(s, right, left) {
  const tip = s.ox + s.w;
  assert.equal(right.length, left.length,
    "precondition: the move should last the same number of frames whichever " +
    "way he faces; " + right.length + " against " + left.length);

  for (let i = 0; i < right.length; i++) {
    const a = right[i], b = left[i];
    assert.equal(a.k, b.k,
      "precondition: the two traces should line up frame for frame; " +
      "row " + i + " is frame " + a.k + " facing right and " + b.k + " facing left");
    /* A pixel of slack, and only a pixel. A rectangle is placed by its LEFT
       edge, so a drawing mirrored perfectly about his center can still land
       one column over on one side; anything past that is the whip reaching
       further one way than the other. */
    assert.ok(Math.abs(a.fwd - b.fwd) <= 1,
      "the whip has to reach the same distance whichever way he faces: on " +
      "frame " + a.k + " it reached " + a.fwd + " forward facing right and " +
      b.fwd + " facing left");
    assert.ok(Math.abs(a.back - b.back) <= 1,
      "and hang the same distance behind him: on frame " + a.k + " it went " +
      a.back + " back facing right and " + b.back + " facing left");
  }

  /* Measured rather than inferred from the comparison above, because two
     traces that both drew nothing at all agree with each other perfectly. */
  const stretched = left.filter((r) => r.fwd >= tip - 1);
  assert.ok(stretched.length >= s.active,
    "and facing LEFT it has to be a whip at full stretch for the " + s.active +
    " frames it can hit, out at the end of its own box (" + tip + " pixels to " +
    "his left); it was there on " + stretched.length + " frames");
}

test("the whip mirrors: facing left it reaches left by the same amount", async () => {
  const run = await arena(SQUALLS, REESE);
  const s = whipSpec(run);
  checkWhipMirrors(s, whipTrace(run, SP_UP, 1, 0), whipTrace(run, SP_UP, -1, 0));
});

test("negative control: a whip that ignores facing fails the mirror test", async () => {
  /* The multiply that turns the curve around, dropped. Facing right is
     untouched -- every frame of it is pixel for pixel what it was -- and
     facing left he cracks a whip out of the back of his head while the hitbox
     stays where it always was, in front of him. */
  const run = await arena(SQUALLS, REESE, { engine: sabotage(
    "      const X = ax + facing * fwd, Y = ay + Math.round(py);",
    "      const X = ax + fwd, Y = ay + Math.round(py);") });
  const s = whipSpec(run);
  expectToFail(
    () => checkWhipMirrors(s, whipTrace(run, SP_UP, 1, 0), whipTrace(run, SP_UP, -1, 0)),
    "with the facing multiply gone the mirror test should fail; it passed");
});
