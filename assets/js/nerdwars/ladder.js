/* NerdWars: the match log, head-to-head records, and the ladder.
 *
 * The whole of this file is a pure function of an append-only log plus one
 * small storage port. It never imports Firebase and never touches the DOM.
 * That is deliberate twice over: the game must not know where results are
 * kept, and every rule in here has to be testable with no network.
 *
 *   createLadder(store)   -> window.NerdWarsLadder
 *   memoryStore()         -> the same port over a Map, for tests
 *
 * WHAT A MATCH LOOKS LIKE
 *
 *   matches/{mid}                 written once, by the host
 *     { at, uids[], names[], chars[], stage, winnerSlot, stocks[],
 *       frames, build, host }
 *   matches/{mid}/confirm/{uid}   written once, by everybody else
 *     { agree, winnerSlot }
 *
 * One document for the match, not one per player, and that is the difference
 * between an orderable log and an unorderable one. Four machines produce four
 * wall clocks; nothing synchronises them, so "replay the log in timestamp
 * order" is not even defined if the timestamp is per-report. One document
 * means one clock and one `at`, and `(at, mid)` is then a TOTAL order that
 * every client folds identically.
 *
 * WHY NOT UNANIMITY
 *
 * The obvious rule is "count it when everybody agrees". It is wrong, and the
 * way it is wrong is worth writing down: it does not stop lying, it makes
 * every loss optional. Nobody has to forge anything -- the loser closes the
 * tab and the match never counts. That is free, silent, and indistinguishable
 * from a flat battery.
 *
 * So the rule is CONTRADICTION, not silence:
 *
 *   counted   nobody disagreed, and at least one person who is not the host
 *             said so out loud
 *   disputed  somebody actively disagreed -- shown, by name, never dropped
 *   pending   nobody has confirmed yet
 *
 * A host can still fabricate a match. Against nine friends looking at the
 * same ladder, an unconfirmed match sitting there with somebody's name on it
 * is the same social enforcement the unanimity rule was reaching for, without
 * making every defeat voluntary.
 *
 * A disputed match is LOUD on purpose. Two honest clients can genuinely
 * disagree -- the desync check compares a 32-bit hash every thirty confirmed
 * frames, so a divergence inside the last thirty is never caught -- and
 * silently discarding those would throw away the only evidence that the
 * engine has a bug.
 */
(function () {
  "use strict";

  var START = 1000;          // everybody's first rating
  var K_NEW = 40;            // while provisional: move fast, find the level
  var K = 20;                // once settled
  var PROVISIONAL = 10;      // matches before a rating is worth believing

  /* ---------------- the pure part ---------------- */

  /** Has this match been agreed, argued over, or not looked at yet? */
  function verdictOf(m) {
    var confirms = m.confirm || {};
    var others = 0, against = 0;
    for (var uid in confirms) {
      if (!Object.prototype.hasOwnProperty.call(confirms, uid)) continue;
      if (uid === m.host) continue;              // the author agreeing with
      others++;                                  // themselves proves nothing
      if (confirms[uid].agree === false) against++;
      else if (confirms[uid].winnerSlot !== undefined &&
               confirms[uid].winnerSlot !== m.winnerSlot) against++;
    }
    if (against) return "disputed";
    return others > 0 ? "counted" : "pending";
  }

  /** Only two-player matches are rated. See the note in fold(). */
  function isRateable(m) {
    return (m.uids || []).filter(Boolean).length === 2;
  }

  function expected(a, b) {
    return 1 / (1 + Math.pow(10, (b - a) / 400));
  }

  /* Total order. `at` first, then the id -- and the id tiebreak is not
     decoration: two matches written in the same millisecond would otherwise
     fold in whatever order the query returned them, and Elo is order
     dependent, so two clients would show two different ladders. */
  function inOrder(a, b) {
    if (a.at !== b.at) return a.at - b.at;
    return a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0;
  }

  /**
   * The whole ladder, from the whole log.
   *
   * Returns players (rating, record, provisional), head-to-head, and the
   * matches themselves with a verdict on each.
   */
  function fold(matches) {
    var log = (matches || []).slice().sort(inOrder);
    var players = {};        // uid -> { uid, name, rating, w, l, d, played }
    var h2h = {};            // uid -> opponent uid -> { w, l, d }
    var counted = 0, disputed = 0, pending = 0, unrated = 0;

    function seat(uid, name) {
      if (!players[uid]) {
        players[uid] = { uid: uid, name: name || uid, rating: START,
                         w: 0, l: 0, d: 0, played: 0 };
      }
      // The most recent name a person played under is the one to show.
      if (name) players[uid].name = name;
      return players[uid];
    }

    function pair(a, b) {
      if (!h2h[a]) h2h[a] = {};
      if (!h2h[a][b]) h2h[a][b] = { w: 0, l: 0, d: 0 };
      return h2h[a][b];
    }

    var out = log.map(function (m) {
      var verdict = verdictOf(m);
      var uids = (m.uids || []);
      var names = (m.names || []);
      uids.forEach(function (u, i) { if (u) seat(u, names[i]); });

      if (verdict !== "counted") {
        if (verdict === "disputed") disputed++; else pending++;
        return { mid: m.mid, at: m.at, verdict: verdict, uids: uids,
                 names: names, chars: m.chars || [], stage: m.stage,
                 winnerSlot: m.winnerSlot, rated: false };
      }
      counted++;

      /* Rated only for two players. Elo has no agreed meaning for a
         free-for-all, and this game does not record the ORDER people were
         eliminated in anyway -- at the end every loser simply has no stocks
         -- so a four-way carries no information to rate with beyond who
         survived. They are logged, they count for head-to-head nothing, and
         they wait for somebody to decide what a four-way is worth. */
      if (!isRateable(m)) {
        unrated++;
        return { mid: m.mid, at: m.at, verdict: verdict, uids: uids,
                 names: names, chars: m.chars || [], stage: m.stage,
                 winnerSlot: m.winnerSlot, rated: false };
      }

      var a = seat(uids[0]), b = seat(uids[1]);
      // null is a genuine result: both last stocks can go on the same frame.
      var sa = m.winnerSlot === 0 ? 1 : m.winnerSlot === 1 ? 0 : 0.5;
      var ea = expected(a.rating, b.rating);
      var ka = a.played < PROVISIONAL ? K_NEW : K;
      var kb = b.played < PROVISIONAL ? K_NEW : K;

      a.rating += ka * (sa - ea);
      b.rating += kb * ((1 - sa) - (1 - ea));
      a.played++; b.played++;
      if (sa === 1) { a.w++; b.l++; pair(a.uid, b.uid).w++; pair(b.uid, a.uid).l++; }
      else if (sa === 0) { a.l++; b.w++; pair(a.uid, b.uid).l++; pair(b.uid, a.uid).w++; }
      else { a.d++; b.d++; pair(a.uid, b.uid).d++; pair(b.uid, a.uid).d++; }

      return { mid: m.mid, at: m.at, verdict: verdict, uids: uids,
               names: names, chars: m.chars || [], stage: m.stage,
               winnerSlot: m.winnerSlot, rated: true };
    });

    var rows = Object.keys(players).map(function (u) {
      var p = players[u];
      return { uid: p.uid, name: p.name, rating: Math.round(p.rating),
               w: p.w, l: p.l, d: p.d, played: p.played,
               provisional: p.played < PROVISIONAL };
    });
    /* Provisional players sort below settled ones whatever their number
       says. Three wins and a rating of 1120 is not a position on a ladder,
       it is three wins, and putting it above somebody with forty matches
       makes the whole table read as noise. */
    rows.sort(function (x, y) {
      if (x.provisional !== y.provisional) return x.provisional ? 1 : -1;
      if (y.rating !== x.rating) return y.rating - x.rating;
      return y.played - x.played;
    });

    return { rows: rows, h2h: h2h, matches: out,
             counted: counted, disputed: disputed, pending: pending,
             unrated: unrated };
  }

  /** Head-to-head between two people, from a folded view. */
  function between(view, a, b) {
    var r = (view.h2h[a] || {})[b];
    return r ? { w: r.w, l: r.l, d: r.d } : { w: 0, l: 0, d: 0 };
  }

  /* ---------------- the port ---------------- */

  /** The same four operations over a Map. Everything above is testable. */
  function memoryStore(shared) {
    var db = shared || { matches: {}, profiles: {} };
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    return {
      writeMatch: function (mid, doc) {
        if (db.matches[mid]) return Promise.resolve(false);   // create-only
        db.matches[mid] = clone(doc);
        db.matches[mid].confirm = {};
        return Promise.resolve(true);
      },
      writeConfirm: function (mid, uid, doc) {
        var m = db.matches[mid];
        if (!m) return Promise.resolve(false);
        if (m.confirm[uid]) return Promise.resolve(false);    // create-only
        m.confirm[uid] = clone(doc);
        return Promise.resolve(true);
      },
      listMatches: function (since) {
        var out = [];
        for (var mid in db.matches) {
          if (!Object.prototype.hasOwnProperty.call(db.matches, mid)) continue;
          var m = clone(db.matches[mid]);
          m.mid = mid;
          if (!since || m.at > since) out.push(m);
        }
        return Promise.resolve(out);
      },
      getProfile: function (uid) {
        return Promise.resolve(db.profiles[uid] ? clone(db.profiles[uid]) : null);
      },
      setProfile: function (uid, doc) {
        db.profiles[uid] = clone(doc);
        return Promise.resolve(true);
      },
      __db: db,
    };
  }

  /* ---------------- what the game talks to ---------------- */

  /* A confirm can reach the database before the match it confirms.

     Both machines reach the end of the same match on the same frame and both
     report it immediately, so whose write lands first is a race between two
     network connections. The host writes the match; everybody else writes a
     confirm ON that match -- and a confirm on a document that does not exist
     yet is not a race that resolves itself, it is refused outright. Nothing
     retried, so the confirm was simply lost and the match sat on "pending"
     forever, which is indistinguishable from the loser refusing to agree.

     Six tries over about eight seconds. The host's write is one round trip;
     anything slower than that is a connection in trouble, and a confirm that
     never lands still leaves a visible pending match rather than a wrong
     result. */
  var CONFIRM_TRIES = 6;
  var CONFIRM_WAIT = 400;

  function laterBy(ms) {
    return new Promise(function (done) {
      if (typeof setTimeout === "function") setTimeout(done, ms);
      else done();            // a sandbox with no timers retries at once
    });
  }

  function createLadder(store, opts) {
    var cache = { loading: false, error: null, at: 0, matches: [],
                  view: fold([]) };
    // Injectable so a test does not have to wait eight real seconds to prove
    // that it waits.
    var wait = (opts && opts.wait) || laterBy;

    function refold() { cache.view = fold(cache.matches); return cache.view; }

    function refresh() {
      if (!store || cache.loading) return Promise.resolve(cache.view);
      cache.loading = true;
      cache.error = null;
      /* Incremental. The log is append-only and immutable, so everything
         already folded stays folded -- only what is new has to be read.
         Reading the whole log on every view is what breaks first on the free
         tier: a year of play is thousands of documents and a handful of
         leaderboard views a day would spend the daily read quota. */
      return store.listMatches(cache.at).then(function (fresh) {
        var seen = {};
        cache.matches.forEach(function (m) { seen[m.mid] = true; });
        (fresh || []).forEach(function (m) {
          if (seen[m.mid]) {
            for (var i = 0; i < cache.matches.length; i++) {
              if (cache.matches[i].mid === m.mid) { cache.matches[i] = m; break; }
            }
          } else {
            cache.matches.push(m);
          }
          if (m.at > cache.at) cache.at = m.at;
        });
        cache.loading = false;
        refold();
        return cache.view;
      }, function (err) {
        cache.loading = false;
        cache.error = String((err && err.message) || err);
        return cache.view;
      });
    }

    return {
      /** A snapshot to draw. Never blocks, never throws. */
      view: function () {
        return { loading: cache.loading, error: cache.error,
                 rows: cache.view.rows, matches: cache.view.matches,
                 counted: cache.view.counted, disputed: cache.view.disputed,
                 pending: cache.view.pending };
      },
      between: function (a, b) { return between(cache.view, a, b); },
      refresh: refresh,

      /**
       * Whoever gets there first writes the match down. The other one agrees.
       *
       * It used to be the room's HOST who wrote and everybody else who
       * confirmed, and that made the record depend on one particular machine
       * being awake and in front at the end of the match. It was not: the
       * winner leaves the results screen first, because the winner is the one
       * still pressing attack, and leaving is what used to trigger reporting.
       * So when the guest won, its confirm arrived seconds before the host had
       * written anything for it to confirm -- and a confirm on a document that
       * does not exist is refused outright, not queued. Four counted, two
       * pending, and the two were exactly the two the guest won.
       *
       * `host` on the document now means "who wrote this down", which is all
       * the ladder ever used it for: it is the one confirm that does not count
       * as corroboration, because agreeing with yourself is not evidence.
       */
      report: function (match) {
        if (!store || !match || !match.mid) return Promise.resolve(false);
        var mine = match.me;
        if (!mine) return Promise.resolve(false);

        return store.writeMatch(match.mid, {
          at: match.at, uids: match.uids, names: match.names,
          chars: match.chars, stage: match.stage,
          winnerSlot: match.winnerSlot, stocks: match.stocks,
          frames: match.frames, build: match.build, host: mine,
        }).then(function (authored) {
          if (authored) return true;
          /* Somebody else wrote it first -- the write is create-only, so
             exactly one machine can win that -- which makes this one the
             corroborator. */
          var doc = { agree: match.agree !== false,
                      winnerSlot: match.winnerSlot };
          var tries = 0;
          function attempt() {
            return store.writeConfirm(match.mid, mine, doc).then(function (ok) {
              if (ok || tries >= CONFIRM_TRIES) return ok;
              tries++;
              return wait(CONFIRM_WAIT * tries).then(attempt);
            });
          }
          return attempt();
        });
      },

      profile: function (uid) { return store ? store.getProfile(uid) : Promise.resolve(null); },
      setProfile: function (uid, doc) { return store ? store.setProfile(uid, doc) : Promise.resolve(false); },

      // Pure, and exported so the rules can be tested without a store.
      __fold: fold,
      __verdict: verdictOf,
      __store: store,
    };
  }

  var api = { createLadder: createLadder, memoryStore: memoryStore,
              fold: fold, verdictOf: verdictOf, between: between,
              START: START, K: K, K_NEW: K_NEW, PROVISIONAL: PROVISIONAL };

  if (typeof window !== "undefined") {
    window.NerdWarsLadderKit = api;
    /* A fake store injected by a test wins, exactly the way net.js prefers an
       injected Peer. Production wiring happens in the page, which is the only
       place that knows about Firebase. */
    if (window.NerdWarsFakeStore) {
      window.NerdWarsLadder = createLadder(window.NerdWarsFakeStore);
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
