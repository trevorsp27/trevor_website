# Trevor Website Starter

This is a GitHub Pages-ready personal website starter.

## What you have

- `index.html` - Main About page
- `pages/publications.html` - Publications page
- `pages/experience.html` - Work experience page
- `pages/music.html` - Music page
- `pages/bounce-bots.html` - Bounce Bots, a live multiplayer puzzle game
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

### A note on caching

GitHub Pages serves everything with `Cache-Control: max-age=600`, so edits go live within
ten minutes on their own. The `?v=<date>` tokens on script and stylesheet tags make a
change appear immediately instead. When you edit a *shared* file such as
`assets/js/site-data.js`, bump its token in **every** page that loads it, or most of the
site will keep reading a cached copy for up to ten minutes. The game's ES module imports
carry no tokens and rely on the ten-minute expiry.

### Running the tests

The game logic has no DOM or network dependencies, so it runs under Node directly:

```bash
npm test
```

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
