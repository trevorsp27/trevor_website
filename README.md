# Trevor Website Starter

This is a GitHub Pages-ready personal website starter.

## What you have

- `index.html` - Main About page
- `pages/publications.html` - Publications page
- `pages/music.html` - Music page
- `pages/experience.html` - Work experience page
- `pages/interests.html` - Interests page
- `pages/projects.html` - Projects page
- `pages/_template.html` - Copy this to create a new page quickly
- `assets/js/site-data.js` - Single source of truth for site name, intro text, nav links, and homepage cards
- `assets/css/styles.css` - Shared design system

## Add a new subpage in under 2 minutes

1. Copy `pages/_template.html` to a new file in `pages/`.
2. Edit the new page's `title`, `<meta description>`, `body data-page`, hero text, and content.
3. Open `assets/js/site-data.js` and add a new object to the `pages` array:

```js
{
  id: "projects",
  title: "Projects",
  path: "pages/projects.html",
  summary: "A showcase of things I have built.",
  icon: "Projects"
}
```

4. Save. The nav and home page cards update automatically.

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
