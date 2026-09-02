# Trevor Website Starter

This is a GitHub Pages-ready personal website starter.

## What you have

- `index.html` - Main About page
- `pages/publications.html` - Publications page
- `pages/experience.html` - Work experience page
- `pages/music.html` - Music page
- `pages/bounce-bots.html` - Bounce Bots, a live multiplayer puzzle game
- `pages/nerdwars.html` - NerdWars, a two-player platform fighter
- `pages/_template.html` - Copy this to create a new page quickly
- `assets/js/site-data.js` - Single source of truth for site name, intro text, nav links, and homepage cards
- `assets/css/styles.css` - Shared design system

## Add a new subpage in under 2 minutes

1. Copy `pages/_template.html` to a new file in `pages/`.
2. Edit the new page's `title`, `<meta description>`, `body data-page`, hero text, and content.
3. Open `assets/js/site-data.js` and add a new object to the `pages` array:

```js
{
  id: "new-page",
  title: "New Page",
  path: "/pages/new-page.html",
  summary: "A short description of this page.",
  icon: "Page"
}
```

4. Save. The nav and home page cards update automatically.

## Bounce Bots

A live multiplayer puzzle game at `pages/bounce-bots.html`. Robots slide until they hit
something; players race to find the shortest route to the target, bid a move count, then
prove it.

The site stays fully static. There is no game server: the lobby leader's browser is the
authority and other players connect straight to it over WebRTC via PeerJS. Boards are
generated deterministically from the four-character lobby code, so every player builds an
identical board from a shared seed rather than downloading one.

Source lives in `assets/js/bounce-bots/`:

- `constants.js` - board vocabulary shared by every other module
- `rng.js` - seeded PRNG, so a lobby code always yields the same board
- `board.js` - wall, target, and diagonal generation
- `rules.js` - movement simulation (pure, no DOM)
- `solver.js` - BFS used to guarantee each round is solvable and not a one-move gimme
- `game.js` - authoritative round state machine, run only by the host
- `net.js` - PeerJS wrapper
- `ui.js` - canvas renderer
- `main.js` - page wiring and input

Clients ping the host every few seconds. WebRTC gives no reliable signal when a peer's
tab is closed abruptly, so the host drops anyone who goes quiet for ten seconds rather
than waiting on the transport to notice.

## NerdWars

A two-player platform fighter at `pages/nerdwars.html`, built from pixel sprites the
author and his friends drew in 2018. Seven characters, five stages, three specials and an ult each, fought over
health bars rather than Smash-style ring-outs. Specials draw on a mana pool so nothing can be spammed, and
the ult meter charges faster for whoever is losing.

**The web build is online-only.** The mount carries `data-nerdwars="online"`,
which tells the engine to skip its local menu entirely: the only way into a
match is the lobby on the page. The standalone build still has local play and a
CPU. Two players share one keyboard; a CPU fills the
second slot in one-player mode. Five stages, six characters.

### The JavaScript here is generated - do not hand-edit it

`assets/js/nerdwars/sprites.js` and `assets/js/nerdwars/game.js` are **build output**. The
source lives in a separate project (`NerdWars/src/nerdwars.js` plus the sprite folders),
and both files carry a "do not edit" banner. Edits made here are lost on the next build.

To regenerate them, run the build in the NerdWars project with `NERDWARS_SITE` pointed at
this folder:

```bash
NERDWARS_SITE=/path/to/trevor_website python src/build.py
```

That writes both files, and also rebuilds the standalone `NerdWars.html`, so the site
copy and the standalone copy can never drift apart.

`sprites.js` is one namespaced global, `window.NERDWARS_ASSETS`, holding every sprite and
tile as base64 data URIs - one request rather than eighty. `game.js` wraps the whole
engine in an IIFE, so the only name it adds to the page is the read-only `window.NerdWars`
status object (`scene`, `stage`, `focused`, `ready`, `keys`, `frames`, `fighters`), which
is there for debugging and for wiring up netplay later.

### Online play

Two browsers connect straight to each other over WebRTC, introduced by PeerJS's
public broker, exactly as Bounce Bots does. The site stays static and there is
still nothing to run.

The model is different from Bounce Bots, though. Bounce Bots is
host-authoritative: the leader's browser decides and the others ask. That suits
a turn-based puzzle and would be wrong here, because it gives the guest visible
lag on every input. NerdWars instead runs **deterministic lockstep** - both
machines run the identical simulation and exchange only which buttons were
pressed on which frame, a few bytes each way.

`assets/js/nerdwars/net.js` is only the transport and the lobby. The frame
buffer lives in the engine, reached through `window.NerdWars.net`:

- `start({ localSlot, chars, stage, delay, send, onEvent })` begins a match
- `receive(msg)` feeds it whatever arrives from the other side
- `status` reports frame, stalls, and desync

Both machines read the **same keys** (WASD and friends) regardless of which slot
they occupy. Online there is one person per keyboard, so reading each side's own
slot bindings just meant the guest was on player two's arrow keys while reaching
for WASD — jump and most specials silently did nothing. `tests/nerdwars-netplay.test.js`
covers this now.

Each side runs `delay` frames behind its own input (4 by default, so ~66ms):
what you press now is scheduled for frame N+delay, which gives the packet that
long to arrive. Frame N is simulated only once *both* sides' inputs for N are in
hand - until then the game waits rather than guessing, because guessing is what
rollback does and rollback needs to be able to rewind. That means a slow
connection shows up as hitching, not as the two players seeing different fights.

Lockstep only works if the simulation is genuinely identical on both machines,
which constrains the engine:

- **No runtime trig.** `Math.sin` and `Math.cos` are not guaranteed to agree to
  the last bit across JavaScript engines. Every knockback angle is a constant,
  so each move stores `kx`/`ky` - its cosine and sine - as literals. The build
  verifies them against the angle and refuses to build if they disagree.
- **No AI.** The CPU uses `Math.random`, so online matches are human vs human.
- Randomness elsewhere (particles, the starfield, background pulses) never
  feeds back into game state, so it is free to differ.

Every 30 frames each side hashes the exact float bits of its state and sends it
across. A mismatch stops the match and says so, rather than quietly letting two
people play different games.

### Keyboard focus

The game only takes the keyboard while the player has clicked inside it. `game.js` looks
for a `[data-nerdwars]` mount and, when it finds one, starts in an unfocused state and
sets `data-nerdwars-focus="on"` / `"off"` on that element as the player clicks in and out.
Until it is focused it does not call `preventDefault`, so arrow keys and space still
scroll the page normally. Clicking away also clears every held key, so nothing sticks
down. `assets/css/nerdwars.css` uses that attribute to fade the "click to play" prompt.

Without a `[data-nerdwars]` mount - as in the standalone build - the game assumes it owns
the page and is focused from the start.

### A note on caching

GitHub Pages serves everything with `Cache-Control: max-age=600`, so edits go live within
ten minutes on their own. The `?v=<date>` tokens on script and stylesheet tags make a
change appear immediately **once the new HTML arrives** — which is the part worth being
precise about, because the tokens live *inside* the page, and the page is under the same
`max-age=600` as everything else. A returning visitor can still be up to ten minutes
behind before they even see the new token strings, and a tab left open across a deploy
stays on the old assets until it is reloaded. What the tokens actually buy you is that a
fresh page never gets served stale assets against an unchanged URL — not that everybody
updates the instant you push.

That distinction matters for NerdWars online: `net.js` carries a `PEER_PREFIX` that is
bumped whenever the wire format changes, so two people on different builds cannot connect
at all. That is deliberate — connecting and then desyncing would be worse — but during
the cache window it just looks like a bad room code, so the join-failure message names it
as a possible cause. When you edit a *shared* file such as
`assets/js/site-data.js`, bump its token in **every** page that loads it, or most of the
site will keep reading a cached copy for up to ten minutes.

The Bounce Bots ES modules carry the token on **every internal import**
(`from "./constants.js?v=..."`), and all of them plus the `<script type="module">` tag in
`pages/bounce-bots.html` must be bumped together. Without that, a freshly fetched
`main.js` can be linked against a cached `constants.js`: the module graph fails to
resolve, nothing boots, and the page renders normally while doing nothing at all. Tests
in `tests/bounce-bots-modules.test.js` enforce that the tokens stay in sync. To bump
them:

```bash
sed -i -E 's|\?v=[0-9a-z]+|?v=NEWTOKEN|g' assets/js/bounce-bots/*.js
```

### Running the tests

The game logic has no DOM or network dependencies, so it runs under Node directly:

```bash
npm test
```

`tests/nerdwars-netplay.test.js` boots two independent copies of the NerdWars
engine inside `vm` contexts with a stubbed DOM and a hand-cranked
`requestAnimationFrame`, wires each one's output into the other, and plays 900
frames with different inputs on each side. Driving the clock by hand is what
makes a frame-exact test possible. The assertion is the game's own desync
detector: if the two simulations ever disagreed by a single bit, the test
fails.

### Working on it locally

ES modules will not load over `file://`. Serve the folder over HTTP:

```bash
python -m http.server 8765
```

Then open `http://localhost:8765/pages/bounce-bots.html`.

## Publish with GitHub Pages

1. Create a new repository named `trevor_website` under `https://github.com/trevorsp27`.
2. Run these commands from this folder:

```powershell
git init
git branch -M main
git add .
git commit -m "Initial personal website scaffold"
git remote add origin https://github.com/trevorsp27/trevor_website.git
git push -u origin main
```

3. On GitHub, go to **Settings -> Pages**.
4. Under **Build and deployment**, set:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main`
   - **Folder**: `/ (root)`
5. Save. GitHub will give you a public URL in about a minute.

## Quick customization checklist

- In `assets/js/site-data.js`, update:
  - `ownerName`
  - `email`
  - `githubUrl`
  - `about` text
- Replace placeholder content in each page.
- Optional: swap colors in `assets/css/styles.css` variables.

## Profile photo setup

1. Add your photo in the `assets/` folder.
2. Recommended filename: `profile.jpg`.
3. The site will automatically:
  - show it on the About page hero section
  - generate a circular browser/tab icon from the same image

Supported filenames by default: `profile.jpg`, `profile.jpeg`, `profile.png`, `profile.webp`.
