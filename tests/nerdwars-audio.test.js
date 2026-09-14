/* NerdWars audio.
 *
 * The engine must boot and play a whole match on a machine with no Web Audio
 * at all -- that is what the node:vm sandbox is, and it is also a real
 * browser with audio blocked. So the first thing these tests assert is
 * silence-without-crashing, and only then that sound happens when it can.
 *
 * The AudioContext here is a recording fake: every node it hands out logs the
 * calls made against it, so a test can assert on the shape of the graph a
 * recipe built without needing to hear anything.
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
/* Takes a seed now, the way nerdwars-confuse.test.js's copy already did.

   Without one, each boot draws from the counter and therefore from a
   different stream -- which is fine for a test that boots one engine, and
   fatal for the two tests below that boot a PAIR and feed them one script,
   expecting identical fights. That was survivable while both seats were
   humans who pressed nothing. The title offers a CPU match now, and a CPU
   calls Math.random, so an unseeded pair diverges on frame one. */
function seededMath(seed) {
  let s = seed === undefined
    ? (0x9e3779b9 ^ (++__seedCounter * 2654435761)) >>> 0 || 1
    : (seed >>> 0) || 1;
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
const GAME = readFileSync(path.join(JS_DIR, "game.js"), "utf8");

/* One line of the engine, changed in memory. Never written to disk, and
   never handed to anything but a negative control.

   Both halves are asserted. A needle that is missing, or that appears twice,
   makes a control that mutates nothing or mutates the wrong line -- which is
   exactly the failure a negative control exists to rule out, so it must be a
   loud error rather than a quietly green run. */
function sabotage(needle, replacement) {
  const at = GAME.indexOf(needle);
  assert.ok(at >= 0,
    "sabotage needle not found in the engine: " + JSON.stringify(needle));
  assert.equal(GAME.indexOf(needle, at + 1), -1,
    "sabotage needle is not unique in the engine: " + JSON.stringify(needle));
  return GAME.slice(0, at) + replacement + GAME.slice(at + needle.length);
}

/* The other half of a negative control: the SAME checker the real test ran,
   which now has to throw -- and to throw on the assertion the control was
   aimed at. `want` is matched against the message because a checker that
   dies somewhere else entirely (on its own precondition, say, because the
   sabotage also broke the fight) has proved nothing, and without this check
   it would be indistinguishable from a control that worked. Anything that
   is not an assertion failure is rethrown as itself: that is a broken
   checker, not a caught regression. */
function expectToFail(check, want, why) {
  try {
    check();
  } catch (e) {
    if (e && e.code === "ERR_ASSERTION") {
      assert.ok(
        String(e.message).includes(want),
        why + " -- it did fail, but on the wrong assertion: " + e.message
      );
      return;
    }
    throw e;
  }
  assert.fail(why);
}

function stubContext() {
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return () => ({ addColorStop() {} });
        }
        if (key === "measureText") return () => ({ width: 0 });
        if (key === "canvas") return { width: 0, height: 0 };
        return () => {};
      },
      set() {
        return true;
      },
    }
  );
}

function stubCanvas(w, h) {
  const el = {
    width: w,
    height: h,
    style: {},
    getContext: () => stubContext(),
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    toDataURL: () => "",
  };
  el.parentElement = {
    clientWidth: w,
    clientHeight: h,
    contains: () => true,
    dataset: {},
  };
  return el;
}

/** An AudioContext that records instead of making noise. */
function recordingAudioContext() {
  const log = [];
  const param = (node, name) => ({
    value: 0,
    setValueAtTime(v, t) {
      log.push({ node, param: name, op: "set", value: v, time: t });
      return this;
    },
    linearRampToValueAtTime(v, t) {
      log.push({ node, param: name, op: "lin", value: v, time: t });
      return this;
    },
    exponentialRampToValueAtTime(v, t) {
      log.push({ node, param: name, op: "exp", value: v, time: t });
      return this;
    },
    cancelScheduledValues() {
      return this;
    },
  });
  const make = (kind) => {
    const n = { kind };
    n.connect = (dest) => {
      log.push({ node: kind, op: "connect", to: dest && dest.kind });
      return dest;
    };
    n.disconnect = () => {};
    n.start = (t) => log.push({ node: kind, op: "start", time: t });
    n.stop = (t) => log.push({ node: kind, op: "stop", time: t });
    n.gain = param(kind, "gain");
    n.frequency = param(kind, "frequency");
    n.detune = param(kind, "detune");
    n.pan = param(kind, "pan");
    n.Q = param(kind, "Q");
    n.type = "";
    n.buffer = null;
    return n;
  };
  return {
    log,
    currentTime: 0,
    state: "running",
    sampleRate: 48000,
    destination: { kind: "destination" },
    resume() {
      this.state = "running";
      return Promise.resolve();
    },
    createGain: () => make("gain"),
    createOscillator: () => make("osc"),
    createBiquadFilter: () => make("filter"),
    createStereoPanner: () => make("panner"),
    createBufferSource: () => make("bufsrc"),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
  };
}

/**
 * Like recordingAudioContext, but createOscillator throws exactly once: on
 * the next call after `ctx.arm()` is invoked, not simply "the Nth call ever
 * made". Counting calls from context creation would silently retarget the
 * throw at whatever oscillator API happens to run first -- a future
 * startup chime, say -- leaving the test passing while it exercises
 * something other than what it claims to. Arming immediately before the
 * call under test pins the throw to that call and nothing else. The
 * recording fake above accepts any recipe without complaint, so this is
 * how a test gets something for audioFlush's inner per-item try/catch to
 * actually catch -- standing in for a malformed recipe hitting a real Web
 * Audio API (an invalid oscillator type, a non-finite frequency, and so
 * on).
 */
function throwingAudioContext() {
  const ctx = recordingAudioContext();
  const realCreateOscillator = ctx.createOscillator;
  let armed = false;
  ctx.arm = () => {
    armed = true;
  };
  ctx.createOscillator = () => {
    if (armed) {
      armed = false;
      throw new Error("simulated malformed recipe");
    }
    return realCreateOscillator();
  };
  return ctx;
}

/**
 * Boot one engine.
 * @param {object} [opts]
 * @param {boolean} [opts.audio] install a recording AudioContext (default off,
 *   which is the important case: the engine must survive without one)
 * @param {function} [opts.makeAudioContext] factory for the fake AudioContext
 *   to install when opts.audio is set (default recordingAudioContext) --
 *   how a test swaps in throwingAudioContext instead
 * @param {string} [opts.engine] engine source to run instead of the real
 *   one -- how a negative control boots a sabotage() copy. The mutation
 *   lives in this vm and nowhere else; nothing ever writes it to disk.
 */
async function bootGame(opts) {
  const withAudio = !!(opts && opts.audio);
  const makeAudioContext = (opts && opts.makeAudioContext) || recordingAudioContext;
  const decodeSeconds = opts && opts.decode != null ? opts.decode : null;
  const engineSrc = (opts && opts.engine) || GAME;
  const view = stubCanvas(960, 540);
  const winListeners = new Map();
  const docListeners = new Map();
  const viewListeners = new Map();
  const rafQueue = [];
  let clock = 0;

  const on = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  view.addEventListener = on(viewListeners);

  let recorder = null;

  const sandbox = {
    console,
    Math: seededMath(opts && opts.seed),
    JSON,
    Date,
    Promise,
    Object,
    Array,
    Map,
    Set,
    Number,
    String,
    Boolean,
    Error,
    DataView,
    ArrayBuffer,
    Uint8Array,
    Float32Array,
    Float64Array,
    isNaN,
    parseInt,
    parseFloat,
    requestAnimationFrame: (cb) => rafQueue.push(cb),
    innerWidth: 960,
    innerHeight: 540,
    addEventListener: on(winListeners),
    Image: class {
      constructor() {
        this.complete = true;
        this.naturalWidth = 16;
        this.naturalHeight = 16;
      }
      set src(v) {
        this._src = v;
        if (this.onload) this.onload();
      }
      get src() {
        return this._src;
      }
    },
    document: {
      getElementById: (id) =>
        id === "nw-canvas" || id === "game" ? view : null,
      querySelector: () => null,
      createElement: () => stubCanvas(320, 180),
      addEventListener: on(docListeners),
      documentElement: {},
      fullscreenElement: null,
    },
  };

  if (opts && opts.music) {
    // A stand-in for the detached <audio> elements the music player builds.
    // Without one the harness has no Audio constructor at all, which is a
    // real case worth testing -- but it means the player's own logic (fade,
    // play/pause, switching on scene) is never executed by anything.
    sandbox.Audio = function (src) {
      const el = {
        src: src,
        currentSrc: src,
        loop: false,
        preload: "",
        volume: 1,
        paused: true,
        currentTime: 0,
        duration: 60,
        play() {
          this.paused = false;
          return Promise.resolve();
        },
        pause() {
          this.paused = true;
        },
      };
      return el;
    };
  }

  if (withAudio) {
    sandbox.AudioContext = function () {
      recorder = makeAudioContext();
      // A working decoder, when a test asks for one. Most tests deliberately
      // run without: a machine that cannot decode is a real case and the
      // engine must survive it. But every sample assertion in that mode is
      // "silent, not fatal", which is trivially true -- and that is exactly
      // how an envelope that faded a recording to inaudibility once shipped
      // with a green suite. opts.decode is how the sample path gets actually
      // exercised.
      if (decodeSeconds != null) {
        const rate = recorder.sampleRate;
        const buf = {
          duration: decodeSeconds,
          length: Math.round(decodeSeconds * rate),
          numberOfChannels: 1,
          sampleRate: rate,
          getChannelData: () => new Float32Array(Math.round(decodeSeconds * rate)),
        };
        recorder.decodeAudioData = function (_bytes, ok) {
          if (typeof ok === "function") ok(buf);
          return Promise.resolve(buf);
        };
      }
      return recorder;
    };
    if (decodeSeconds != null) {
      // The engine base64-decodes the inlined data URI itself, so it needs
      // atob. Absent by default, which is the case that proves unlocking
      // without it does not throw.
      sandbox.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
    }
  }

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SPRITES, sandbox, { filename: "sprites.js" });
  vm.runInContext(engineSrc, sandbox, { filename: "game.js" });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  const fire = (map, type, ev) => {
    for (const fn of map.get(type) || []) fn(ev);
  };

  return {
    nw: sandbox.window.NerdWars,
    get audioLog() {
      return recorder ? recorder.log : [];
    },
    get recorder() {
      return recorder;
    },
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const due = rafQueue.splice(0, rafQueue.length);
        clock += 1000 / 60;
        for (const cb of due) cb(clock);
      }
    },
    /** Let pending decode promises settle. */
    async settle() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    press: (code) =>
      fire(winListeners, "keydown", { code, preventDefault() {} }),
    release: (code) => fire(winListeners, "keyup", { code }),
    click: () =>
      fire(viewListeners, "mousedown", { clientX: 10, clientY: 10 }),
  };
}

export { bootGame, recordingAudioContext };

test("the engine boots and runs with no Web Audio at all", async () => {
  const g = await bootGame();
  assert.equal(g.nw.ready, true, "assets should have loaded");
  assert.equal(g.nw.scene, "title");
  g.pump(120);
  assert.ok(g.nw.frames > 100, "the loop should keep running without audio");
});

test("audio reports itself unavailable before any gesture", async () => {
  const g = await bootGame({ audio: true });
  assert.equal(g.nw.audio.ready, false, "no context until a gesture");
});

test("a keypress unlocks audio", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  assert.equal(g.nw.audio.ready, true, "keydown should unlock");
});

test("a canvas click unlocks audio", async () => {
  const g = await bootGame({ audio: true });
  g.click();
  assert.equal(g.nw.audio.ready, true, "mousedown should unlock");
});

test("unlocking twice does not build a second context", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  const first = g.recorder;
  g.press("KeyX");
  assert.equal(g.recorder, first, "the context should be created once");
});

test("a recipe with a pitch sweep builds an oscillator that ramps", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "sine", f0: 180, f1: 34, dur: 0.4, curve: "exp", gain: 0.9 });

  const log = g.audioLog;
  const osc = log.filter((e) => e.node === "osc");
  assert.ok(osc.some((e) => e.op === "start"), "the oscillator should start");
  assert.ok(osc.some((e) => e.op === "stop"), "and be stopped, not left running");

  const freq = log.filter((e) => e.node === "osc" && e.param === "frequency");
  assert.equal(freq[0].value, 180, "should start at f0");
  assert.equal(freq[freq.length - 1].value, 34, "and end at f1");
});

test("a recipe with no f1 holds a steady pitch", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "square", f0: 440, dur: 0.1, gain: 0.5 });

  const freq = g.audioLog.filter((e) => e.node === "osc" && e.param === "frequency");
  assert.equal(freq.length, 1, "one set, no ramp");
  assert.equal(freq[0].value, 440);
});

test("a noise burst builds a buffer source through a lowpass", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ noise: { dur: 0.09, lp: 900 }, dur: 0.09, gain: 0.8 });

  const log = g.audioLog;
  assert.ok(log.some((e) => e.node === "bufsrc" && e.op === "start"), "noise source");
  const cutoff = log.filter((e) => e.node === "filter" && e.param === "frequency");
  assert.equal(cutoff[0].value, 900, "lowpass at the recipe's cutoff");
});

test("gain is never scheduled as zero, which would throw on an exponential ramp", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.test({ osc: "sine", f0: 200, dur: 0.2, gain: 0 });

  const gains = g.audioLog.filter((e) => e.param === "gain" && e.op === "exp");
  for (const e of gains) {
    assert.ok(e.value > 0, "exponentialRamp to " + e.value + " would throw");
  }
});

test("playing a recipe with audio locked does nothing and does not throw", async () => {
  const g = await bootGame({ audio: true });
  g.nw.audio.test({ osc: "sine", f0: 200, dur: 0.2, gain: 0.5 });
  assert.equal(g.audioLog.length, 0, "no context, no nodes");
});

/** Count how many voices reached the graph. */
function voiceCount(log) {
  return log.filter((e) => e.op === "start").length;
}

test("the same cue on the same frame for the same slot plays once", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "three emissions, one voice");
});

test("the same cue for different slots plays once each", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 100 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 2, "two fighters, two sounds");
});

test("the same cue on a later frame plays again", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  g.nw.audio.emit("test-a", { slot: 0, frame: 101 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 2, "a repeated jab is two jabs");
});

/* The whole reason the bus does not copy addEffect's guard. A hit that only
   the corrected timeline contains is emitted only during the replay; if
   replays were suppressed it would be silent forever. */
test("a cue that appears only during resimulation still plays", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.__test.setResimulating(true);
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.__test.setResimulating(false);
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "the corrected timeline must be audible");
});

/* Despite the name of its setup, this does not drive a real rollback --
   cue() never reads netplay.resimulating, so the two setResimulating calls
   below are inert. What it actually verifies is that a key stays remembered
   across a flush boundary, which is what a real rollback also depends on:
   the second emission has to find the first one's key still in audioPlayed
   after audioBatch has already been cleared out from under it. */
test("dedupe survives a flush boundary", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.flush();
  g.nw.__test.setResimulating(true);
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.__test.setResimulating(false);
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 1, "one hit, one sound, however many flushes");
});

test("an unknown cue name is ignored rather than throwing", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("no-such-cue", { slot: 0, frame: 1 });
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 0);
});

test("cues emitted with audio locked are dropped, not queued up", async () => {
  const g = await bootGame({ audio: true });
  g.nw.audio.emit("test-a", { slot: 0, frame: 1 });
  g.nw.audio.flush();
  g.press("KeyZ");
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 0, "no burst of backlog on unlock");
});

/* Every test above passes an explicit frame, so audioNow() -- the code path
   a real cue actually takes -- never ran. That gap is how the mismatch
   between audioNow()'s and frame()'s idea of which clock is live got past
   review the first time. g.pump() drives the real animation-frame loop, so
   the offline step counter advances for real between the two emissions.

   It does not advance by exactly one tick per pump(), though: frame()'s
   accumulator is timed off floating-point deltas, so a given pump() can
   land zero or two ticks as well as one (confirmed by instrumenting the
   loop directly). So this polls for the next tick rather than assuming a
   fixed pump count -- a bounded number of tries, not a sleep, over a
   deterministic clock. */
test("a cue emitted with no explicit frame is keyed by the simulated tick", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0 });
  g.nw.audio.flush();
  const before = voiceCount(g.audioLog);
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) {
    g.pump(1);
    g.nw.audio.emit("test-a", { slot: 0 });
    g.nw.audio.flush();
    after = voiceCount(g.audioLog);
  }
  assert.equal(after, before + 1, "a later simulated tick is a new voice");
});

test("panning follows x: opposite edges of the stage pan opposite ways", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  // VW, the engine's stage width, is 320.
  g.nw.audio.emit("test-a", { slot: 0, frame: 300, x: 0 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 300, x: 320 });
  g.nw.audio.flush();
  const pans = g.audioLog
    .filter((e) => e.node === "panner" && e.param === "pan" && e.op === "set")
    .map((e) => e.value);
  assert.equal(pans.length, 2, "both voices should be panned");
  assert.ok(pans[0] < 0, "the left edge should pan negative");
  assert.ok(pans[1] > 0, "the right edge should pan positive");
});

test("the played set does not grow without bound", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let f = 0; f < 2000; f++) {
    g.nw.audio.emit("test-a", { slot: 0, frame: f });
    g.nw.audio.flush();
  }
  // NET_MAX_ROLLBACK is 36; the set holds a small multiple of that, not 2000.
  assert.ok(
    g.nw.audio.pending < 200,
    "played set held " + g.nw.audio.pending + " keys after 2000 frames"
  );
});

test("a cue older than the rollback window may play again", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 0 });
  g.nw.audio.flush();
  for (let f = 1; f < 400; f++) {
    g.nw.audio.emit("test-b", { slot: 0, frame: f });
    g.nw.audio.flush();
  }
  const before = g.audioLog.filter((e) => e.op === "start").length;
  // No rollback can reach frame 0 any more, so its key is gone and this is a
  // new sound rather than a suppressed duplicate.
  g.nw.audio.emit("test-a", { slot: 0, frame: 0 });
  g.nw.audio.flush();
  assert.equal(
    g.audioLog.filter((e) => e.op === "start").length,
    before + 1
  );
});

// The bucket key and `when` are both keyed on the same frame (100) here, so
// this test alone cannot tell the current per-bucket cap apart from the
// simpler per-flush-by-name cap it replaced -- see the two tests below for
// that. What this one still pins down: eight voices on the exact same
// instant are capped to three.
test("at most three voices of one recipe play on the same instant", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 8; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
  }
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 3, "eight emissions, three voices");
});

test("different recipes in one flush are not capped against each other", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 4; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
    g.nw.audio.emit("test-b", { slot, frame: 100 });
  }
  g.nw.audio.flush();
  assert.equal(voiceCount(g.audioLog), 6, "three of each");
});

// Distinguishes the per-bucket cap from the simpler per-flush-by-name cap it
// replaced. Six emissions of one recipe, two each 50ms time bucket (offsets
// 0-1, 3-4, 6-7 frames from the batch's earliest frame) -- more than
// AUDIO_MAX_VOICES (3) in the flush overall, but never more than 2 in any
// one bucket. A cap that counted by name across the whole flush, ignoring
// time, would drop three of these; the real rule caps within a bucket, so
// none should be dropped.
test("cues of one recipe spread across time buckets are not pooled into one cap", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 101 });
  g.nw.audio.emit("test-a", { slot: 2, frame: 103 });
  g.nw.audio.emit("test-a", { slot: 3, frame: 104 });
  g.nw.audio.emit("test-a", { slot: 4, frame: 106 });
  g.nw.audio.emit("test-a", { slot: 5, frame: 107 });
  g.nw.audio.flush();
  assert.equal(
    voiceCount(g.audioLog),
    6,
    "six cues in three distinct time buckets, none should be dropped"
  );
});

// The blocker this wave fixes: the voice-cap bucket and `when` used to
// disagree about time past AUDIO_MAX_BATCH_STEPS -- the bucket kept
// splitting a same-clock spread into new buckets by its raw, unclamped
// offset, while `when` collapsed every one of those cues onto the same
// clamped instant. Eleven emissions of one recipe, 3 frames (50ms) apart,
// reproduces a rollback replaying many frames of one clock inside a single
// frame() loop iteration. Against the pre-fix code this piled eight
// identical voices onto one instant (2.6x AUDIO_MAX_VOICES) -- exactly the
// coherent-summing spike the cap exists to prevent. The fix computes the
// clamped offset once and reuses it for both the bucket key and `when`, so
// no single instant can ever collect more than AUDIO_MAX_VOICES voices.
test("a same-clock spread past the batch clamp does not pile voices onto one instant", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let f = 0; f <= 30; f += 3) {
    g.nw.audio.emit("test-a", { slot: 0, frame: f });
  }
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.op === "start").map((e) => e.time);
  const byTime = new Map();
  for (const t of starts) byTime.set(t, (byTime.get(t) || 0) + 1);
  for (const [t, n] of byTime) {
    assert.ok(
      n <= 3,
      "time " + t + " has " + n + " voices, past the cap of 3"
    );
  }
  // Pinned to the exact shape the clamp produces: two buckets of one voice
  // each (offsets 0 and 3 frames), then the third bucket -- offset 6 plus
  // everything from offset 9 on, clamped to 8 -- capped at three, so two of
  // its nine candidates are dropped rather than all nine playing.
  assert.equal(
    starts.length,
    5,
    "11 emissions, capped down to 5 voices across three time buckets"
  );
});

test("stacked voices are attenuated and detuned", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  for (let slot = 0; slot < 3; slot++) {
    g.nw.audio.emit("test-a", { slot, frame: 100 });
  }
  g.nw.audio.flush();

  const peaks = g.audioLog
    .filter((e) => e.node === "gain" && e.param === "gain" && e.op === "exp")
    .map((e) => e.value)
    .filter((v) => v > 0.01);
  assert.ok(peaks[0] > peaks[1], "the second voice should be quieter");
  assert.ok(peaks[1] > peaks[2], "and the third quieter still");

  const detunes = g.audioLog.filter((e) => e.param === "detune");
  assert.ok(detunes.length >= 2, "duplicates should be detuned apart");
});

test("cues from different frames in one flush keep their spacing", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-b", { slot: 0, frame: 104 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.op === "start").map((e) => e.time);
  assert.equal(starts.length, 2);
  const gap = Math.abs(starts[1] - starts[0]);
  const expected = 4 * (1000 / 60) / 1000;   // four frames, in seconds
  assert.ok(
    Math.abs(gap - expected) < 0.002,
    "expected ~" + expected.toFixed(4) + "s apart, got " + gap.toFixed(4)
  );
});

test("cues on the same frame are simultaneous", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-b", { slot: 1, frame: 100 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.op === "start").map((e) => e.time);
  assert.equal(starts[0], starts[1], "one frame, one instant");
});

test("scheduling never lands in the past", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("test-a", { slot: 0, frame: 200 });
  g.nw.audio.emit("test-b", { slot: 0, frame: 100 });   // out of order
  g.nw.audio.flush();

  const now = g.recorder.currentTime;
  for (const e of g.audioLog.filter((x) => x.op === "start")) {
    assert.ok(e.time >= now, "scheduled at " + e.time + " but now is " + now);
  }
});

/**
 * Navigate from the title screen into a real two-human battle.
 *
 * The task brief that first specified these tests reached this point with
 * two Enter taps, on the assumption that the default title selection puts
 * an engine straight into a fight. It does not: MODES[0], the default, is
 * "1 PLAYER (vs CPU)" and needs four confirms -- title, lock seat 0, lock
 * seat 1, stage -- to reach `battle` at all. With only two, an engine
 * silently sits on the character-select screen for the rest of the test,
 * `fighters` stays `[]` the whole time, and a determinism assertion after it
 * compares two empty arrays -- passing without ever exercising a fight.
 * Confirmed by instrumenting the two given tests directly: with the
 * brief's original two-tap script, nw.scene was still "select" and
 * nw.fighters.length was 0 after all 400 scripted frames.
 *
 * Simply pressing through to a CPU match does not fix that either. The CPU
 * brain (aiThink, around line 4132 of src/nerdwars.js) calls Math.random()
 * directly with no seed shared between processes, so two independently
 * booted engines with a CPU-controlled fighter diverge from each other on
 * their own -- confirmed by fighting two silent, audio-free engines against
 * this same script and watching the CPU seat's position and state disagree
 * between them. That divergence is real, but it has nothing to do with
 * audio, and folding a CPU seat into this test would make it fail (or pass)
 * for reasons unrelated to what it exists to prove.
 *
 * So this selects MODES[1], "2 PLAYERS (local)": both seats are driven by
 * the scripted keys the tests already send, nothing in the fight is left to
 * chance, and a mismatch between two engines fed the same script can only
 * mean one of them wrote something the other didn't. The KeyS/Enter/KeyG/
 * Comma/Enter sequence below matches startMatch()'s mode-1 branch in
 * nerdwars-fourplayer.test.js, an independent confirmation that this is
 * really how the suite already reaches a two-human local match.
 */
/* Into a match, on the mode the title still offers.

   This used to pick "2 PLAYERS (local)" and lock two seats on two attack
   keys. That entry is gone, so it takes the first row -- 1 PLAYER vs CPU --
   and Enter drives the whole way: one seat at a time at the select, then the
   stage. Seat 1 is a bot rather than a second human who never moved, which
   is why the paired tests below now hand both engines the same seed. */
function enterBattle(g) {
  const tap = (code, after) => {
    g.pump(2);
    g.press(code);
    g.pump(2);
    g.release(code);
    g.pump(after === undefined ? 2 : after);
  };
  tap("Enter");   // title  -> enterSelect()
  tap("Enter");   // select -> lock seat 0, move to seat 1
  tap("Enter");   // select -> lock seat 1, scene = 'stage'
  tap("Enter", 4); // stage -> startBattle()
}

/**
 * Walk both seats toward each other -- seat 0 with KeyD, seat 1 with
 * ArrowLeft, their spawns face each other across the middle of the stage --
 * until they are actually within jab range, then let go. Run identically
 * across every engine in `engines`.
 *
 * This counted 29 frames until DEEP SPACE was widened from 176 to 240, at
 * which point the walk stopped arriving and every jab afterwards swung at
 * open air. The tests still passed the parts that mattered to them and failed
 * only on their own "did anything actually happen" guard -- which is the
 * guard earning its keep, but the fix is to stop counting frames.
 *
 * The loop is driven off engines[0] and every engine is pumped the same
 * number of frames, so they stay in lockstep -- which is the entire point of
 * the comparison these feed.
 */
function bringIntoContact(engines) {
  const apart = (g) => Math.abs(g.nw.fighters[0].x - g.nw.fighters[1].x);
  for (const g of engines) {
    g.press("KeyD");
    g.press("ArrowLeft");
  }
  let n = 0;
  while (n < 200 && apart(engines[0]) > 18) {
    for (const g of engines) g.pump(1);
    n++;
  }
  for (const g of engines) {
    g.release("KeyD");
    g.release("ArrowLeft");
  }
  assert.ok(
    apart(engines[0]) <= 24,
    "could not walk the two fighters into jab range in " + n + " frames; " +
      "they are " + apart(engines[0]).toFixed(0) + "px apart, so the blows " +
      "traded after this would all be whiffs"
  );
}

/**
 * Trade jabs for `rounds` rounds, identically across every engine in
 * `engines`: both seats' attack key held for 2 frames then released, then 6
 * frames to let the swing (and, when it connects, hitstun) play out before
 * the next one. A plain walk-and-swing script mostly whiffs a jab's few-
 * frame-active hitbox as the fighters keep walking past each other; closing
 * the distance once with bringIntoContact() and then holding position while
 * trading blows here is what actually connects. Verified empirically: with
 * this stage's spawn points, one seat's jab starts landing (health 100 ->
 * 90) within the first ~15 rounds and the fight is deterministic -- 3
 * consecutive runs of this exact script produced byte-identical fighter
 * state and stateHash every time. Always leaves both attack keys released,
 * whatever `rounds` is, so a caller can chain more rounds or a plain
 * `pump()` afterward without an attack key stuck down.
 *
 * `onRound`, if given, runs once per round with the round index -- the hook
 * the audio tests use to emit cues without duplicating this script.
 */
function tradeBlows(engines, rounds, onRound) {
  for (let r = 0; r < rounds; r++) {
    for (const g of engines) {
      g.press("KeyG");
      g.press("Comma");
    }
    for (const g of engines) g.pump(2);
    for (const g of engines) {
      g.release("KeyG");
      g.release("Comma");
    }
    for (const g of engines) g.pump(6);
    if (onRound) onRound(r);
  }
}

/**
 * Walk the two fighters back together, whichever side of each other they
 * have ended up on.
 *
 * bringIntoContact() above always walks seat 0 RIGHT, which is correct
 * exactly once: at the spawns, where seat 1 starts to his right. Blows land,
 * bodies move, and a seat 0 whose opponent is now on his LEFT walks away
 * from him for 200 frames and then swings at the horizon. This reads the
 * sign of the gap first and holds whichever key actually closes it.
 *
 * Driven off engines[0] and pumping every engine the same number of frames,
 * exactly like bringIntoContact(), so the lockstep the comparisons below
 * depend on survives. 10px, not 18: AUTISNICK's jab is ox 2, w 11 against a
 * 9-wide hurtbox, so it reaches about 17px of center-to-center gap and
 * stopping at the edge of that spends the round on a whiff.
 */
function closeTheGap(engines) {
  const gap = () =>
    engines[0].nw.fighters[1].x - engines[0].nw.fighters[0].x;
  const key = gap() > 0 ? "KeyD" : "KeyA";
  for (const g of engines) g.press(key);
  let n = 0;
  while (n < 90 && Math.abs(gap()) > 10) {
    for (const g of engines) g.pump(1);
    n++;
  }
  for (const g of engines) g.release(key);
}

/**
 * tradeBlows(), but closing the distance before every round rather than once
 * before the first.
 *
 * Standing still and swinging was enough while the CPU seat stayed in front
 * of it. It no longer does: measured against this engine, a fifteen-round
 * bringIntoContact()-then-tradeBlows() script lands NOTHING -- the first nine
 * rounds are spent inside COMBAT.respawnInvuln (110 frames, and a round is
 * 8), so every early jab passes through a target that cannot be hurt however
 * close it is, and by the time the i-frames lapse Reese has walked 90px away
 * from a seat 0 who never follows. Re-closing each round, first blood lands
 * on round 6 and the fight keeps trading after it.
 */
function tradeBlowsInRange(engines, rounds, onRound) {
  for (let r = 0; r < rounds; r++) {
    closeTheGap(engines);
    tradeBlows(engines, 1);
    if (onRound) onRound(r);
  }
}

/* The whole safety argument in one test: two engines fed identical inputs must
   reach identical state, whether or not either of them is making noise. If
   audio ever reads a value it then writes back, this is what catches it --
   `fighters` is a legible six-field readout for when this fails, but
   `stateHash` is the assertion with teeth: bit-exact floats across all
   eleven fighter fields stateHash covers, plus every projectile position,
   none of which `fighters` exposes.

   Measured, the same way as the test below: emitting throughout an
   unbroken 30 rounds of tradeBlows with no idle stretch catches `combo`
   for a sufficiently non-idempotent write (confirmed with combo forced to
   99; forcing it to 1 was not enough, since real combat already passes
   through 1 on its own early in the fight, making that particular write a
   no-op most of the time it lands). It shares the test below's blind spot
   for `ultMeter` and `volleyHits` regardless -- nothing in this script
   casts an ult, so neither is ever read, no matter how long the fight
   runs -- and it has a third blind spot of its own: `shield`. Neither seat
   ever holds a shield key here, so a write into it goes unread; measured
   directly with `shield = 0` injected into audioVoice, this test still
   passes. */
test("an engine with audio and one without stay in identical states", async () => {
  // One seed for both: the fight has a bot in it, and two bots drawing from
  // two streams are two different fights.
  const loud = await bootGame({ audio: true, seed: 20260913 });
  const mute = await bootGame({ seed: 20260913 });
  // Unlocking directly, rather than loud.press("KeyZ"), means the two
  // engines are fed strictly identical input throughout the test: a
  // one-sided keypress is inert at the title screen today, but it is a
  // trap waiting for KeyZ to mean something there later, and unlock()
  // touches only AUDIO.ac/master, never `held`, so there is nothing for it
  // to feed unevenly in the first place.
  loud.nw.audio.unlock();

  for (const g of [loud, mute]) enterBattle(g);
  for (const g of [loud, mute]) {
    assert.equal(
      g.nw.scene,
      "battle",
      "the script above should have started a real fight"
    );
  }

  bringIntoContact([loud, mute]);
  // Emit on the loud engine only, varying slot and x every round so cue(),
  // audioVoice(), the pan math and the voice limiter all genuinely execute
  // during the frames being compared -- not just audioFlush pruning an
  // empty batch. Both recipes, not just test-a: test-b is the only noise
  // recipe, and audioNoise() is the one audio code path that draws from an
  // RNG stream to build what it plays, so it needs its own turn inside a
  // real two-engine comparison rather than being asserted safe only by
  // the same "nothing here writes back" reasoning that covers everything
  // else in this file.
  tradeBlows([loud, mute], 30, (r) => {
    loud.nw.audio.emit("test-a", { slot: r % 2, x: (r * 11) % 320 });
    loud.nw.audio.emit("test-b", { slot: (r + 1) % 2, x: (r * 7) % 320 });
  });

  const fighters = loud.nw.fighters;
  assert.ok(
    fighters.some((f) => f.health < 100),
    "the script above should have landed a real hit, not just moved around"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fighters)),
    JSON.parse(JSON.stringify(mute.nw.fighters)),
    "audio must be invisible to the simulation"
  );
  assert.equal(
    loud.nw.__test.stateHash(),
    mute.nw.__test.stateHash(),
    "audio must be invisible to the simulation, bit for bit"
  );
  assert.ok(
    voiceCount(loud.audioLog) > 0,
    "the loud engine really did make sound"
  );
});

/* This is the only test that runs audioVoice against a live battle, so it is
   the one built to catch a write the moment it happens rather than after the
   frames being compared have already settled.

   The scenario is run once by flushMidMatch() and MEASURED rather than
   asserted on the spot, so the negative controls at the end of this file can
   drive the identical script against a sabotaged engine and hand the
   identical checker the identical readout. Nothing is given up by deferring
   the assertions: every checkpoint is a snapshot taken at the instant it is
   named -- a stateHash is a number, and `fighters` is deep-copied -- so
   comparing them at the end is exactly as strict as comparing them there.

   WHY THE SCRIPT NOW CLOSES THE DISTANCE EVERY ROUND. It used to be
   bringIntoContact() once, then fifteen rounds of standing still and jabbing,
   and that stopped landing anything at all -- which the precondition below
   caught, exactly as it was written to. Two things stack up against a
   standing script: every fighter spawns with COMBAT.respawnInvuln (110)
   frames of invulnerability and a round is 8 frames, so the first nine rounds
   swing at a target that cannot be hurt however close it is (measured: seat
   0's jab overlapping Reese's hurtbox, `invulnerable` true, on every one of
   those frames); and by the time the i-frames lapse the CPU has walked 90px
   away from a seat 0 who never follows him. tradeBlowsInRange() follows, and
   first blood lands on round 6 with both fighters down real health well
   before the flush under test.

   An earlier version also let ~60 idle frames pass after the flush before
   comparing (every key released). Measured with an actual write injected into
   audioVoice: an idle window erased a position/velocity-class write outright
   -- vx snaps to exactly 0 when grounded with no input held -- and never made
   a hitstop-class write observable at all, since nothing was happening for an
   extra frozen frame to shift the timing of. Fixed by checking stateHash
   immediately after the flush, before anything can settle a position/velocity
   write away, and by replacing the idle window with more rounds of combat, so
   hitstop has real behavior to alter.

   WHAT EACH CHECKPOINT CATCHES, measured field by field by injecting a write
   into audioVoice and running this same checker against the result. Scoped to
   the cue under test where it says so (`recipe.f0 === 440` is test-a and
   nothing else), because an unscoped write also fires on the engine's own
   combat cues -- 22 of them before the flush under test -- and has already
   diverged the two engines long before the flush, which says nothing about
   which checkpoint earned the catch:
     - vx and x (position/velocity-class): caught by the immediate hash, and
       that is the only place a cue-scoped one is still legible.
     - hitstop: the immediate hash still AGREES. hitstop is not one of the
       eleven fields stateHash covers, so it is only ever visible through the
       frame of timing it steals, and the active window is what develops it
       into a difference. That is what the window is for, and why it runs with
       nothing idle between it and the flush.
     - shield: caught only by the `fighters` comparison after the shield hold,
       with both hashes still agreeing at that point -- seat 0 holding
       ShiftLeft on a shield that has been zeroed enters `break` while the
       other seat shields normally. Unscoped only: shield regenerates every
       frame it is not held, so a single doctored cue is long gone by the
       hold. The hold is aimed at the realistic shape of this bug -- a
       write-back inside audioVoice, which fires on every voice -- not at one
       doctored cue.
     - ultMeter: caught by the `fighters` comparison, which exposes `ult`, and
       by nothing else: it is not in stateHash, and nothing in this script
       casts an ult, so it never feeds back into the fight.
     - volleyHits: NOT caught, even unscoped. It is the stale-damage counter a
       multi-projectile ult drives, and nothing here casts one, so no volley
       ever exists to register a hit against. A write into it ships undetected
       here, the same as it did before this test was rewritten.
     - combo: NOT caught here, scoped or not, but IS caught by the test above
       for a sufficiently non-idempotent write (measured with combo forced to
       99; forcing it to 1 was not enough, since real combat already passes
       through 1 early on) -- see that test's own comment for why the two
       differ on this one field. */
async function flushMidMatch(opts) {
  const engine = opts && opts.engine;
  const wired = await bootGame({ audio: true, seed: 20260913, engine: engine });
  const mute = await bootGame({ seed: 20260913, engine: engine });
  // See the comment in the test above: unlock directly so both engines get
  // strictly identical input.
  wired.nw.audio.unlock();

  const both = [wired, mute];
  for (const g of both) enterBattle(g);
  const scenes = both.map((g) => g.nw.scene);

  bringIntoContact(both);
  tradeBlowsInRange(both, 12); // real mid-match state: a hit has landed
  const bloodied = wired.nw.fighters.some((f) => f.health < 100);

  /* The DELTA across the flush, not the running total. A fight makes its own
     noise -- this engine is 22 voices deep by now -- so a bare "some voice
     exists" check would be satisfied by the last jab that connected, and
     would stay green with the cue under test silently doing nothing at all.
     Measured: the flush under test adds exactly one. */
  const before = voiceCount(wired.audioLog);
  wired.nw.audio.emit("test-a", { slot: 0, frame: 1 });
  wired.nw.audio.flush();
  const voicesFromFlush = voiceCount(wired.audioLog) - before;
  // Sampled here, before anything else runs, because a position/velocity
  // class write is exactly the kind of thing ongoing physics settles away
  // (see the comment above) -- this is the one place it is still visible.
  const afterFlush = both.map((g) => g.nw.__test.stateHash());

  // Active propagation window: more rounds of real combat, not an idle
  // pump(), so a field like hitstop has behavior to alter rather than two
  // characters standing still with nothing happening for it to change. This
  // has to run right here, with nothing between it and the flush above:
  // measured that even a few idle frames inserted before it are enough to
  // let a hitstop-class divergence resolve itself before a key is ever
  // pressed, which is exactly what this window exists to prevent.
  tradeBlowsInRange(both, 8);
  const afterWindow = both.map((g) => g.nw.__test.stateHash());

  /* Hold seat 0's shield key so a write into `shield` is live: the drain
     only reads it, and only trips the break branch, while the key is
     actually held. This runs after the active window rather than before it,
     because measurement showed a shield hold placed between the flush and
     that window erased the hitstop-class divergence before the window could
     develop it -- and the trigger was the timing, not the shield mechanic:
     a few plain idle frames in the same spot erased it just as completely.
     20 frames covers the startup -- shield is only read once a fighter is
     back in a free state, and the first several held frames are still
     finishing whatever swing was in progress -- and it leaves an untouched
     shield well short of breaking, which is what makes a zeroed one
     (`break`) legible against it. */
  for (const g of both) g.press("ShiftLeft");
  for (const g of both) g.pump(20);
  for (const g of both) g.release("ShiftLeft");

  return {
    scenes: scenes,
    bloodied: bloodied,
    voicesFromFlush: voicesFromFlush,
    afterFlush: afterFlush,
    afterWindow: afterWindow,
    // Deep-copied at the instant the hold ends, so the checker compares what
    // was there then rather than whatever the objects say later.
    fighters: both.map((g) => JSON.parse(JSON.stringify(g.nw.fighters))),
    afterShield: both.map((g) => g.nw.__test.stateHash()),
  };
}

/* The assertions, split out so a negative control can run this exact set
   against a sabotaged engine. The two guards come first and stay guards:
   they exist so the comparisons below cannot pass vacuously once the
   scenario stops working, which is precisely what happened to the old
   standing-still script. */
function checkFlushIsInvisible(r) {
  for (const scene of r.scenes) {
    assert.equal(scene, "battle",
      "the script above should have started a real fight");
  }
  assert.ok(r.bloodied,
    "expected a real hit to have landed before the flush under test");
  assert.ok(r.voicesFromFlush > 0,
    "the cue under test should have actually produced a voice");
  assert.equal(r.afterFlush[0], r.afterFlush[1],
    "state must be identical immediately after the flush");
  assert.equal(r.afterWindow[0], r.afterWindow[1],
    "state must be identical after the active window");
  assert.deepEqual(r.fighters[0], r.fighters[1],
    "audio must be invisible to the simulation, field by field");
  assert.equal(r.afterShield[0], r.afterShield[1],
    "state must be identical after the shield hold");
}

test("flushing a cue mid-match does not change the simulation", async () => {
  checkFlushIsInvisible(await flushMidMatch());
});

/* The existing "no Web Audio at all" test above only pumps frames -- it never
   presses a key or clicks the canvas, so audioUnlock()'s actual behavior with
   no AudioContext in scope (the real case on a browser with audio blocked)
   never runs. Both keydown and mousedown call audioUnlock() unconditionally,
   before anything else, so this drives that exact path and checks it leaves
   the game exactly as untouched as inspection alone suggested. */
test("a key press and a canvas click do not throw with no Web Audio at all", async () => {
  const g = await bootGame();
  assert.doesNotThrow(() => {
    g.press("KeyZ");
    g.click();
  }, "audioUnlock must survive a missing AudioContext constructor");
  assert.equal(
    g.nw.audio.ready,
    false,
    "no AudioContext exists anywhere, so audio can never become ready"
  );
  g.pump(60);
  // >= 55, not merely > 0: a loop that ran once and then stalled would pass
  // a bare ">0" check. The file's first test holds itself to the same bar
  // (> 100 after pump(120)).
  assert.ok(
    g.nw.frames >= 55,
    "the loop should keep running after the gesture, not stall after one tick"
  );
});

/* audioFlush wraps each item's audioVoice call in its own try/catch for one
   reason: a single malformed recipe must not throw out of frame() and stop
   requestAnimationFrame from ever being called again. Nothing in the suite
   above ever drives a recipe through that catch, because the recording fake
   context accepts any input without complaint. throwingAudioContext exists
   to make one specific call fail -- the next oscillator built after the test
   arms it -- while a second cue in the same flush must still reach the
   graph. */
test("a cue that throws inside audioVoice does not stop the rest of the flush", async () => {
  const g = await bootGame({
    audio: true,
    makeAudioContext: throwingAudioContext,
  });
  g.press("KeyZ");
  g.recorder.arm(); // only the very next oscillator built will throw
  g.nw.audio.emit("test-a", { slot: 0, frame: 100 });
  g.nw.audio.emit("test-a", { slot: 1, frame: 100 });
  assert.doesNotThrow(
    () => g.nw.audio.flush(),
    "one bad voice must not freeze the loop"
  );
  assert.equal(
    voiceCount(g.audioLog),
    1,
    "the second, valid cue should still have played"
  );
});

/* The extended determinism test above ("an engine with audio and one without
   stay in identical states") does exercise the noise path -- test-b is a
   noise recipe -- but two-human mode never calls aiThink, so nothing in the
   frames it compares ever reads the shared random stream, and no amount of
   consumption there would be observable. What that test proves is the
   write-back property, which the oscillator recipe already covers on its
   own; it does not prove audioNoise() leaves Math.random untouched.

   This closes that directly: wrap Math.random, flush a noise-bearing cue,
   and assert it was never called. audioNoise() fills its buffer with a
   local xorshift32 generator specifically so it never touches the stream
   aiThink() reads for every CPU decision (see the comment on audioNoise()
   in src/nerdwars.js) -- consuming even one draw from that stream would
   shift every CPU decision downstream of the first noise-bearing cue in a
   session. Confirmed this actually catches a regression: pointed at a copy
   of audioNoise() with the xorshift loop swapped back for
   `data[i] = Math.random() * 2 - 1`, this test recorded 24,000 draws (one
   per sample in the half-second buffer) and failed; against the real
   xorshift32 implementation it records zero. */
test("filling the noise buffer draws nothing from Math.random", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  const realRandom = Math.random;
  let draws = 0;
  Math.random = function (...args) {
    draws++;
    return realRandom.apply(this, args);
  };
  try {
    g.nw.audio.emit("test-b", { slot: 0, frame: 1 }); // test-b is the noise recipe
    g.nw.audio.flush();
  } finally {
    Math.random = realRandom;
  }
  assert.ok(
    voiceCount(g.audioLog) > 0,
    "the noise cue under test should have actually produced a voice"
  );
  assert.equal(
    draws,
    0,
    "audioNoise() drew from Math.random " + draws + " time(s)"
  );
});

/* ---------------------------------------------------------------------------
   Phase 2: the first two real sounds.

   `OUT OF THE TREES` plays a recorded one-shot; `THE STROKES` plays a
   synthesized arpeggio. Between them they add the two capabilities phase 1
   deliberately left out -- sample playback and a note sequence -- and the
   first cue() call sites that live in game logic rather than in a test.
   ------------------------------------------------------------------------ */

test("an arpeggio plays one voice per note, rising then falling", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("ult-strokes", { slot: 0, frame: 10 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.node === "osc" && e.op === "start");
  assert.equal(starts.length, 6, "six notes in the sequence, six voices");

  const freqs = g.audioLog
    .filter((e) => e.node === "osc" && e.param === "frequency" && e.op === "set")
    .map((e) => e.value);
  assert.equal(freqs.length, 6);
  // E minor: root, minor third, fifth, octave, and back down.
  const semis = freqs.map((f) => Math.round(12 * Math.log2(f / freqs[0])));
  assert.deepEqual(semis, [0, 3, 7, 12, 7, 3]);
});

test("the arpeggio's notes are spaced, not simultaneous", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  g.nw.audio.emit("ult-strokes", { slot: 0, frame: 10 });
  g.nw.audio.flush();

  const t = g.audioLog
    .filter((e) => e.node === "osc" && e.op === "start")
    .map((e) => e.time);
  for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1];
    assert.ok(
      Math.abs(gap - 0.055) < 0.001,
      "note " + i + " landed " + gap.toFixed(4) + "s after the last"
    );
  }
});

/* The reason the arpeggio is one cue rather than one cue per note. The voice
   limiter caps three copies of a recipe in a 50ms bucket; six notes emitted
   as six cues would lose half of them. */
test("an arpeggio is one cue, so the voice limiter never truncates it", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  // Three separate ults on one frame: 3 cues, 18 notes, none capped away.
  g.nw.audio.emit("ult-strokes", { slot: 0, frame: 10 });
  g.nw.audio.emit("ult-strokes", { slot: 1, frame: 10 });
  g.nw.audio.emit("ult-strokes", { slot: 2, frame: 10 });
  g.nw.audio.flush();

  const starts = g.audioLog.filter((e) => e.node === "osc" && e.op === "start");
  assert.equal(starts.length, 18, "three arpeggios of six notes each");
});

test("a sample cue is silent, not fatal, when nothing has decoded", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  // The harness has no atob and no decodeAudioData, so audioLoadSamples
  // declines and every sample stays undecoded -- the same situation as a
  // browser that cannot decode the file.
  assert.doesNotThrow(() => {
    g.nw.audio.emit("ult-trees", { slot: 0, frame: 10 });
    g.nw.audio.flush();
  });
  assert.equal(voiceCount(g.audioLog), 0, "no buffer, no voice");
  g.pump(10);
  assert.ok(g.nw.frames > 0, "and the loop is still running");
});

test("unlocking without atob or decodeAudioData does not throw", async () => {
  // Guards the boot path: audioLoadSamples runs inside audioUnlock, so a
  // browser missing either API must still reach a playable game.
  const g = await bootGame({ audio: true });
  assert.doesNotThrow(() => g.press("KeyZ"));
  assert.equal(g.nw.audio.ready, true);
  g.pump(30);
  assert.ok(g.nw.frames >= 25);
});

/* An unknown cue name is ignored by design -- audioFlush skips a recipe it
   cannot find. That makes a typo in a cue() call permanently and silently
   inaudible, with no error anywhere. This is the only thing that would catch
   it, and it covers every call site phases 2-6 add, not just today's two. */
test("every cue name used in the engine has a recipe", async () => {
  const names = new Set();
  // Both quote styles and template literals, and tolerant of whitespace: a
  // single-quote-only pattern would silently cover nothing new the first
  // time someone writes cue("x"), while the >= 2 floor below still passed.
  const call = /\bcue\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = call.exec(GAME)) !== null) names.add(m[1]);
  assert.ok(names.size >= 2, "expected the phase-2 call sites, found " + names.size);

  const g = await bootGame({ audio: true });
  const known = new Set(g.nw.audio.recipeNames);
  // Checked against the recipe table rather than by playing each one: a
  // sample recipe is legitimately silent until its buffer decodes, and this
  // harness has no decoder, so "did it make a sound" would fail for a cue
  // that is perfectly correct.
  for (const name of names) {
    assert.ok(
      known.has(name),
      "cue('" + name + "') is called by the engine but names no recipe, " +
        "so it would be silent forever with no error"
    );
  }
});

test("the build inlines the sample into the bundle", async () => {
  assert.match(
    SPRITES,
    /const SAMPLES = \{/,
    "sprites.js should carry a SAMPLES table"
  );
  assert.match(SPRITES, /tyson: "data:audio\/mpeg;base64,/, "tyson.mp3 inlined");
  assert.match(
    GAME,
    /SAMPLES = __A\.SAMPLES/,
    "game.js should pull SAMPLES out of the shared namespace"
  );
});

/* A harness with a working decoder.

   Every sample assertion above is of the "silent, not fatal" kind, which is
   trivially true where nothing can decode -- and that is exactly how a
   sample envelope that faded the recording to inaudibility shipped with a
   green suite. These boot with atob and a decodeAudioData that resolves to a
   buffer of a stated length, so the sample path is actually exercised. */
function decodingBoot(seconds) {
  return {
    audio: true,
    decode: seconds == null ? 0.62 : seconds,
  };
}

/** Level of the gain envelope at `t` seconds after the voice started. */
function envelopeAt(log, t) {
  const ev = log
    .filter((e) => e.node === "gain" && e.param === "gain" && e.time != null)
    .sort((a, b) => a.time - b.time);
  if (!ev.length) return null;
  const t0 = ev[0].time;
  let prev = ev[0];
  for (const e of ev) {
    const at = e.time - t0;
    if (at >= t) {
      if (e.op === "set") return at === t ? e.value : prev.value;
      // exponential between prev and e
      const span = e.time - prev.time;
      if (span <= 0) return e.value;
      const k = (t - (prev.time - t0)) / span;
      return prev.value * Math.pow(e.value / prev.value, k);
    }
    prev = e;
  }
  return prev.value;
}

test("a decoded sample plays at level instead of fading out under itself", async () => {
  const g = await bootGame(decodingBoot(0.62));
  g.press("KeyZ");
  await g.settle();
  assert.ok(g.nw.__test.decodedSamples.includes("tyson"), "the sample should have decoded");

  g.nw.audio.emit("ult-trees", { slot: 0, frame: 10 });
  g.nw.audio.flush();
  assert.ok(voiceCount(g.audioLog) > 0, "a decoded sample should produce a voice");

  const peak = envelopeAt(g.audioLog, 0.01);
  // The bug this exists to catch: a single decay across the whole clip put
  // it 6dB down by 51ms and 40dB down by 314ms of a 620ms recording, so
  // roughly the first sixth was audible. Anything past -3dB at the
  // three-quarter mark is that bug back again.
  const late = envelopeAt(g.audioLog, 0.45);
  const dB = 20 * Math.log10(late / peak);
  assert.ok(
    dB > -3,
    "at 450ms of a 620ms clip the envelope is " + dB.toFixed(1) +
      "dB below peak -- the recording is being faded out under itself"
  );
});

test("a decoded sample still releases rather than clicking off", async () => {
  const g = await bootGame(decodingBoot(0.62));
  g.press("KeyZ");
  await g.settle();
  g.nw.audio.emit("ult-trees", { slot: 0, frame: 10 });
  g.nw.audio.flush();

  const peak = envelopeAt(g.audioLog, 0.01);
  const end = envelopeAt(g.audioLog, 0.62);
  assert.ok(end < peak * 0.01, "the envelope should be closed by the end");
});

/* The same silent-forever failure as a mistyped cue name, one level down:
   rename or mistype an audio file and the recipe that names it plays
   nothing, with no error anywhere. */
test("every sample a recipe names is actually in the bundle", async () => {
  const g = await bootGame({ audio: true });
  const inBundle = new Set();
  const key = /^\s*([A-Za-z_$][A-Za-z0-9_$]*): "data:audio\//gm;
  let m;
  while ((m = key.exec(SPRITES)) !== null) inBundle.add(m[1]);
  assert.ok(inBundle.size > 0, "expected at least one inlined sample");

  for (const name of g.nw.audio.recipeNames) {
    const s = g.nw.__test.recipeSample(name);
    if (!s) continue;
    assert.ok(
      inBundle.has(s),
      "recipe '" + name + "' names sample '" + s + "', which the build did " +
        "not inline -- it would be silent forever with no error"
    );
  }
});

/* The regression this whole set exists for.

   Phase 2 first shipped two sounds, both ults, both on two of six
   characters, both behind a full meter. The audio system was provably
   working and an ordinary match was still completely silent -- which is
   indistinguishable from broken, and no test could tell the difference
   because every test drove cues by hand. This one plays the game. */
test("an ordinary fight makes noise without anybody using an ult", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  enterBattle(g);
  assert.equal(g.nw.scene, "battle");

  const atStart = voiceCount(g.audioLog);
  bringIntoContact([g]);
  // Its own script rather than tradeBlows, which only walks and swings --
  // no jump, no landing, no shield, so it exercises a fraction of what a
  // real match does. This is what a person actually presses.
  const p1 = ["KeyW", "KeyG", "ShiftLeft", "KeyD"];
  const p2 = ["ArrowUp", "Comma", "ShiftRight", "ArrowLeft"];
  for (let round = 0; round < 20; round++) {
    const a = p1[round % p1.length];
    const b = p2[round % p2.length];
    g.press(a);
    g.press(b);
    g.pump(3);
    g.release(a);
    g.release(b);
    g.pump(9);          // long enough for a jump to come back down
  }

  const made = voiceCount(g.audioLog) - atStart;
  assert.ok(
    made > 10,
    "twenty rounds of a real fight produced " + made + " voices. Movement " +
      "and contact have to make sound on their own -- an ult nobody has " +
      "charged yet cannot be the only thing you can hear."
  );
  // Nobody ulted, so neither ult cue can be responsible for any of it.
  assert.ok(
    g.nw.fighters.every((f) => f.health <= 100),
    "sanity: the fight actually happened"
  );
});

test("landing and jumping are audible on their own", async () => {
  const g = await bootGame({ audio: true });
  g.press("KeyZ");
  enterBattle(g);

  const before = voiceCount(g.audioLog);
  // Jump, then wait for the landing.
  g.press("KeyW");
  g.pump(2);
  g.release("KeyW");
  g.pump(60);
  assert.ok(
    voiceCount(g.audioLog) > before,
    "a jump and its landing should be audible with no opponent involved"
  );
});

/* Music.

   Streamed through <audio> elements rather than decoded, because the two
   tracks are 4.2MB on disk and would be ~50MB of PCM resident. That is also
   why they are website-only: build.py copies them beside the page instead of
   inlining them, so the standalone gets an empty table and no music. */

test("the site bundle carries both music tracks", async () => {
  assert.match(SPRITES, /const MUSIC = \{/, "sprites.js should carry a MUSIC table");
  for (const track of ["nostalgia", "nowthatsdeep"]) {
    assert.match(
      SPRITES,
      new RegExp(track + ': "\.\./assets/audio/nerdwars/' + track + '\.mp3"'),
      track + " should resolve one directory up from the page"
    );
  }
  assert.match(GAME, /MUSIC = __A\.MUSIC/, "game.js should pull MUSIC from the namespace");
});

/* The harness has no Audio constructor, which is also a real browser with
   media disabled. Music has to be absent, not fatal -- and it must not stop
   the sound effects, which do not depend on it. */
test("no Audio constructor means no music and no damage", async () => {
  const g = await bootGame({ audio: true });
  assert.equal(typeof g.nw, "object");
  assert.doesNotThrow(() => g.press("KeyZ"));
  assert.equal(g.nw.audio.ready, true, "effects should still unlock");

  g.pump(30);
  assert.ok(g.nw.frames >= 25, "and the loop keeps running");

  // Effects still work with music unavailable.
  g.nw.audio.emit("hit", { slot: 0, frame: 5 });
  g.nw.audio.flush();
  assert.ok(voiceCount(g.audioLog) > 0, "effects are independent of music");
});

test("music starts on the menu and crosses over into a match", async () => {
  const g = await bootGame({ audio: true, music: true });
  g.press("KeyZ");
  g.pump(1);

  let st = g.nw.__test.musicState;
  assert.equal(st.length, 2, "both tracks should have elements");
  const menu = () => g.nw.__test.musicState.find((m) => m.role === "menu");
  const battle = () => g.nw.__test.musicState.find((m) => m.role === "battle");

  // On the title screen the menu track plays and the battle track does not.
  g.pump(40);
  assert.ok(menu().playing, "the menu track should be playing at the title");
  /* Audible, and settled -- rather than a hardcoded level. This used to
     assert `> 0.2`, which quietly encoded the music gain of the day and
     failed the moment the music was turned down; the property that actually
     matters is that it ramped up off zero and then held, not what number it
     landed on. */
  const lifted = menu().volume;
  assert.ok(lifted > 0.02, "should have ramped up off zero, got " + lifted);
  g.pump(30);
  assert.equal(menu().volume, lifted, "and then held at its target");
  assert.ok(!battle().playing, "the battle track should not be");

  // Into a fight: the two swap.
  enterBattle(g);
  assert.equal(g.nw.scene, "battle");
  g.pump(60);
  assert.ok(battle().playing, "the battle track should take over in a match");
  assert.ok(battle().volume > 0.02, "and be audible, got " + battle().volume);
  assert.equal(menu().volume, 0, "while the menu track has faded out");
  assert.ok(!menu().playing, "and stopped rather than looping silently");
});

test("music eases rather than cutting", async () => {
  const g = await bootGame({ audio: true, music: true });
  g.press("KeyZ");
  const seen = [];
  for (let i = 0; i < 6; i++) {
    g.pump(1);
    seen.push(g.nw.__test.musicState.find((m) => m.role === "menu").volume);
  }
  // Strictly rising, and not straight to full on the first frame.
  assert.ok(seen[0] < seen[5], "volume should climb: " + seen.join(", "));
  assert.ok(seen[0] < 0.2, "it should not snap to full volume instantly");
});

test("music loops, so a 67 second track does not end a long match", async () => {
  const g = await bootGame({ audio: true, music: true });
  g.press("KeyZ");
  g.pump(1);
  const st = g.nw.__test.musicState;
  assert.ok(st.length > 0);
  // loop is set on the element itself; surfaced via the engine's own view.
  assert.match(GAME, /el\.loop = true;/, "music elements must loop");
});

/* THE NEGATIVE CONTROLS for "flushing a cue mid-match does not change the
   simulation", one per checkpoint that test carries.

   All three sabotage the same line -- the first statement of audioVoice(),
   the one function every voice in the game passes through -- because that is
   the shape the bug would really take: sound code that reads a fighter and
   writes something back. Only the WIRED engine has an AudioContext, so only
   it ever reaches the injected line; the muted engine boots the same doctored
   text and never runs it, which is what makes the pair diverge.

   They exist to prove the checkpoints are not decoration, and both halves of
   that are measured. Take the active window out and the hitstop control stops
   failing where it is aimed: the hash after the window agrees, the final hash
   agrees too, and only the `fighters` comparison still notices -- a write
   caught in passing rather than by the checkpoint written for it. Take the
   shield hold out and the shield control goes green outright, both hashes and
   `fighters` agreeing. And a checker that had quietly stopped fighting -- the
   failure that brought this test down in the first place -- would fail all
   three of these on the precondition instead, which expectToFail reports as a
   wrong-assertion failure rather than accepting as a catch. */

const AUDIO_VOICE_HEAD =
  "function audioVoice(recipe, when, gain, pan) {\n  const ac = AUDIO.ac;";

/** The same one-line injection, with `stmt` run on entry to every voice. */
function audioVoiceWrites(stmt) {
  return sabotage(
    AUDIO_VOICE_HEAD,
    "function audioVoice(recipe, when, gain, pan) {\n  " + stmt +
      "\n  const ac = AUDIO.ac;"
  );
}

test("negative control: a velocity write inside audioVoice is caught at the flush", async () => {
  /* Half a pixel per frame of extra drift on seat 0, and nothing else in the
     engine touched. Position and velocity are in stateHash, so this lands on
     the first checkpoint -- the one taken before any physics can settle it
     away, which is the entire reason that checkpoint is where it is. */
  const r = await flushMidMatch({
    engine: audioVoiceWrites("if (fighters[0]) fighters[0].vx += 0.5;"),
  });
  expectToFail(
    () => checkFlushIsInvisible(r),
    "state must be identical immediately after the flush",
    "a voice that nudges vx should fail the flush test; it passed"
  );
});

test("negative control: a hitstop write is caught only by the active window", async () => {
  /* Scoped to test-a (f0 440 is that recipe and no other), so the ONLY voice
     that writes anything is the one cue the test flushes by hand -- the
     cleanest possible version of "the flush changed the simulation".

     hitstop is not one of the eleven fields stateHash covers, so the
     immediate checkpoint above sees nothing at all here; what diverges is
     the frame of timing it steals, and that needs frames of real combat to
     turn into a different position. Measured: with this engine the hash
     immediately after the flush still matches, and the hash after the
     window does not. That is the window earning its place. */
  const r = await flushMidMatch({
    engine: audioVoiceWrites(
      "if (recipe.f0 === 440 && fighters[0]) fighters[0].hitstop = 3;"
    ),
  });
  expectToFail(
    () => checkFlushIsInvisible(r),
    "state must be identical after the active window",
    "a cue that freezes a fighter for three frames should fail the flush " +
      "test; it passed"
  );
});

test("negative control: a shield write is caught only after the shield hold", async () => {
  /* Unscoped, because a shield write is only observable while the key is
     held and shield regenerates every frame it is not: a single doctored cue
     at the flush has fully healed by the time ShiftLeft goes down, and a
     scoped version of this control is caught by nothing in the test at all
     (measured). Firing on every voice is also the honest shape of the bug.

     Both hashes still agree when this one fails: `shield` is not in
     stateHash, and what actually differs is that seat 0's zeroed shield
     breaks under the hold while the other seat's does not -- a `state` of
     "break" against "shield", which only the `fighters` comparison sees. */
  const r = await flushMidMatch({
    engine: audioVoiceWrites("if (fighters[0]) fighters[0].shield = 0;"),
  });
  expectToFail(
    () => checkFlushIsInvisible(r),
    "audio must be invisible to the simulation, field by field",
    "a voice that empties a shield should fail the flush test; it passed"
  );
});
