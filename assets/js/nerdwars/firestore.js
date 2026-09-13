/* NerdWars -- the ladder's storage, on Firebase.
 *
 * ladder.js is pure: it folds a match log into ratings and head-to-head and
 * knows nothing about where the log lives. It asks a store five questions --
 * writeMatch, writeConfirm, listMatches, getProfile, setProfile -- and this
 * file is the only place in the project that answers them with a network.
 * Swap this out and the rules, the screen and every test still work.
 *
 * It is also the only file that knows who anybody is. Google sign-in gives a
 * uid that is stable across devices and browsers, which is the whole point:
 * a rating tied to a machine is a rating that disappears when somebody plays
 * on a laptop instead of a desktop, and nine friends with two computers each
 * would have eighteen ratings between them.
 *
 * A module, so `import` works and the SDK is only fetched on the page that
 * uses it. Module scripts run after deferred classic ones, so ladder.js and
 * net.js have both already loaded by the time anything here executes.
 *
 *
 * TIME
 *
 * Elo is order-dependent, so every client has to fold the log in the same
 * order or two people see two different leaderboards. That order cannot come
 * from a client clock: nine friends have nine clocks, and one of them is
 * always an hour out. So `at` is written with the SERVER's timestamp, the
 * rules refuse any other value, and this file converts it back to a number
 * on the way to ladder.js.
 *
 * Confirms arrive AFTER the match they confirm. A reader that asks only for
 * matches newer than the newest it has seen would therefore never see a
 * confirm land on a match it already has -- it would sit on "pending"
 * forever, or until a page reload. So each document also carries `touched`,
 * bumped by a confirm, and the cursor here follows `touched` rather than the
 * `since` ladder.js offers. The port's contract is "everything I might not
 * have seen"; being more careful than asked is allowed.
 */

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* Public by design. A Firebase web config identifies the project; it does
   not authorize anything. Every actual permission lives in firestore.rules
   and in the authorized-domain list, which is why both have to be right. */
const firebaseConfig = {
  apiKey: "AIzaSyCZmw8yJp2c33QPXyc9EAQC4uIYRHBanqw",
  authDomain: "nerdwars-e57e3.firebaseapp.com",
  projectId: "nerdwars-e57e3",
  storageBucket: "nerdwars-e57e3.firebasestorage.app",
  messagingSenderId: "842782625646",
  appId: "1:842782625646:web:47eb13e45b62c691fa7b7f",
};

const MATCHES = "matches";
const PROFILES = "profiles";
/* A ceiling on one query, not on the log. The cursor moves forward over what
   came back, so a log longer than this is read in several refreshes rather
   than in one fetch that hangs the page -- and nine friends will not reach
   it for years. */
const PAGE = 500;

function millis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  return 0;
}

/* ------------------------------------------------------------------ *
 * the store
 * ------------------------------------------------------------------ */

function firestoreStore(db) {
  // Follows `touched`, not the `since` ladder.js passes -- see the note at
  // the top of the file about confirms arriving after their match.
  let cursor = 0;

  return {
    /** Create-only. A result that exists cannot be rewritten by anybody. */
    async writeMatch(mid, m) {
      try {
        await setDoc(doc(db, MATCHES, mid), {
          at: serverTimestamp(),
          touched: serverTimestamp(),
          host: m.host,
          uids: m.uids,
          names: m.names,
          chars: m.chars,
          stage: m.stage,
          winnerSlot: m.winnerSlot === undefined ? null : m.winnerSlot,
          stocks: m.stocks || [],
          frames: m.frames || 0,
          build: m.build || "",
          confirm: {},
        });
        return true;
      } catch (err) {
        /* A rejected write is the normal case for a duplicate, not a fault:
           the rules refuse an overwrite, and so does memoryStore. Anything
           else is worth seeing in the console but is still a `false`. */
        console.warn("[nerdwars] match not written:", err && err.code, err);
        return false;
      }
    },

    /** Also create-only: your confirm goes in once and cannot be retracted. */
    async writeConfirm(mid, uid, c) {
      try {
        await updateDoc(doc(db, MATCHES, mid), {
          ["confirm." + uid]: {
            agree: c.agree !== false,
            winnerSlot: c.winnerSlot === undefined ? null : c.winnerSlot,
          },
          touched: serverTimestamp(),
        });
        return true;
      } catch (err) {
        console.warn("[nerdwars] confirm not written:", err && err.code, err);
        return false;
      }
    },

    /**
     * Everything that has changed since the last call. `since` is ignored on
     * purpose; `cursor` tracks `touched`, which moves when a confirm lands on
     * a match this reader already has.
     */
    async listMatches(/* since */) {
      const after = Timestamp.fromMillis(cursor);
      const q = cursor
        ? query(collection(db, MATCHES), where("touched", ">", after),
                orderBy("touched"), limit(PAGE))
        : query(collection(db, MATCHES), orderBy("touched"), limit(PAGE));
      const snap = await getDocs(q);
      const out = [];
      snap.forEach((d) => {
        const data = d.data();
        const touched = millis(data.touched);
        if (touched > cursor) cursor = touched;
        out.push({
          mid: d.id,
          at: millis(data.at),
          host: data.host,
          uids: data.uids || [],
          names: data.names || [],
          chars: data.chars || [],
          stage: data.stage,
          winnerSlot: data.winnerSlot === undefined ? null : data.winnerSlot,
          stocks: data.stocks || [],
          frames: data.frames || 0,
          build: data.build || "",
          confirm: data.confirm || {},
        });
      });
      return out;
    },

    async getProfile(uid) {
      const d = await getDoc(doc(db, PROFILES, uid));
      return d.exists() ? d.data() : null;
    },

    /* Everybody's name in one read. The leaderboard needs a name for every
       row at once, and asking per row would be one read per player per
       refresh. Unlike the match log this is not append-only -- a name can
       change -- so there is no cursor and it comes back whole. */
    async listProfiles() {
      const snap = await getDocs(collection(db, PROFILES));
      const out = [];
      snap.forEach((d) => out.push({ uid: d.id, name: (d.data() || {}).name }));
      return out;
    },

    async setProfile(uid, p) {
      try {
        await setDoc(doc(db, PROFILES, uid), { name: String(p.name || "") });
        return true;
      } catch (err) {
        console.warn("[nerdwars] profile not written:", err && err.code, err);
        return false;
      }
    },
  };
}

/* A store that cannot answer anything, used when Firebase itself fails to
   load. Without it the game would show "the ladder lives on the website
   copy" ON the website copy, which is the one place that is not true. */
function brokenStore(why) {
  const no = () => Promise.reject(new Error(why));
  return {
    writeMatch: () => Promise.resolve(false),
    writeConfirm: () => Promise.resolve(false),
    listMatches: no,
    getProfile: () => Promise.resolve(null),
    setProfile: () => Promise.resolve(false),
  };
}

/* ------------------------------------------------------------------ *
 * who you are
 * ------------------------------------------------------------------ */

function shortName(user) {
  const raw = (user.displayName || user.email || "player").trim();
  /* A STARTING POINT, not a decision. It is the first word of whatever Google
     was told to call them, which for one of the nine turned out to be "The".
     Anybody can change it on the leaderboard, and once they have, this is
     never consulted again. */
  const first = raw.split(/[\s@]+/)[0];
  return first.length >= 3 ? first : raw.split("@")[0];
}

function wire() {
  let app, auth, db, ladder;
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (err) {
    console.error("[nerdwars] firebase would not start:", err);
    window.NerdWarsLadder =
      window.NerdWarsLadderKit.createLadder(brokenStore(String(err)));
    return;
  }

  ladder = window.NerdWarsLadderKit.createLadder(firestoreStore(db));
  window.NerdWarsLadder = ladder;

  let me = null;
  let signingIn = false;

  /* Sign-in is one click and then never again: Firebase persists the session
     in this browser, so the popup happens once per device and the uid it
     returns is the same one on every other device. That is the whole reason
     this is Google rather than a name typed into a box -- a name in a box is
     a name anybody can type, and a rating that anyone can claim is not a
     rating. */
  const provider = new GoogleAuthProvider();

  async function signIn() {
    if (signingIn || me) return;
    signingIn = true;
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = (err && err.code) || "";
      /* A blocked popup is not a failure to report, it is a different route.
         Redirect leaves and comes back to the same page, and getRedirectResult
         below picks it up. */
      if (code === "auth/popup-blocked" ||
          code === "auth/operation-not-supported-in-this-environment") {
        try { await signInWithRedirect(auth, provider); return; }
        catch (e2) { console.error("[nerdwars] sign-in failed:", e2); }
      } else if (code !== "auth/popup-closed-by-user" &&
                 code !== "auth/cancelled-popup-request") {
        console.error("[nerdwars] sign-in failed:", err);
      }
    } finally {
      signingIn = false;
    }
  }

  getRedirectResult(auth).catch(() => {});

  onAuthStateChanged(auth, (user) => {
    me = user ? { uid: user.uid, name: shortName(user) } : null;
    /* net.js owns the identity for the whole game -- the room ships it in
       the seat list and recordMatch reads it back. Two places holding a
       "who am I" is two places to disagree, so this is the only writer. */
    if (window.NerdWarsLobby && window.NerdWarsLobby.setMe) {
      window.NerdWarsLobby.setMe(me);
    }
    /* Only if they have never picked one. Writing the Google-derived name on
       every sign-in would quietly undo somebody's chosen name the next time
       they opened the page, which is the kind of bug nobody reports because
       it looks like they imagined changing it. */
    if (me) {
      ladder.profile(me.uid).then((p) => {
        if (p && p.name) {
          me = { uid: me.uid, name: p.name };
          if (window.NerdWarsLobby && window.NerdWarsLobby.setMe) {
            window.NerdWarsLobby.setMe(me);
          }
        } else {
          ladder.setProfile(me.uid, { name: me.name });
        }
      }).catch(() => {});
    }
    // A different person is a different leaderboard highlight, and the first
    // sign-in is usually the first time the board can be read at all.
    ladder.refresh();
  });

  window.NerdWarsAuth = {
    me: () => me,
    busy: () => signingIn,

    /**
     * What this person is called on the leaderboard. Applies to every match
     * they have already played as well as the next one -- a board showing one
     * person under two names depending on when the match happened would be
     * worse than not letting them change it.
     */
    setName(name) {
      if (!me) return Promise.resolve(false);
      return ladder.setName(me.uid, name).then((ok) => {
        if (!ok) return false;
        me = { uid: me.uid, name: ladder.nameOf(me.uid) || me.name };
        // net.js holds the one identity the room and the match record use.
        if (window.NerdWarsLobby && window.NerdWarsLobby.setMe) {
          window.NerdWarsLobby.setMe(me);
        }
        return true;
      });
    },

    signIn,
    signOut: () => signOut(auth).catch((e) =>
      console.error("[nerdwars] sign-out failed:", e)),
  };
}

if (window.NerdWarsLadderKit) {
  wire();
} else {
  console.error("[nerdwars] ladder.js has not loaded; no ladder to wire up");
}
