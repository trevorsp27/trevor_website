# Bird Photos Structure

This directory is fully localized.

The Birds page reads local files only:

- `assets/birds/birds-catalog.json`
- `assets/birds/photo-manifest.json`
- `assets/birds/photos/<family-slug>/<species-slug>/...`

## Add photos

1. Find the species folder in `assets/birds/photos/<family-slug>/<species-slug>/`.
2. Drop photo files into that species folder.
3. Run `./scripts/sync-birds.ps1` from the repository root.
4. Commit and push.

That script refreshes:

- `assets/birds/photo-manifest.json` (used for green dots and gallery links)
- `assets/birds/birds-catalog.json` (catalog snapshot)

## Status logic on the Birds page

- `?` means no photo files were found for that species folder
- Green dot means photo files exist for that species folder
- Clicking a species with a green dot opens its gallery page
