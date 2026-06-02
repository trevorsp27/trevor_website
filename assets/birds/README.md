# Bird Photos Structure

Use this structure to keep bird photos organized and make them show up automatically in the Birds page.

## 1) Add photos to species folders

Put photos in:

- `assets/birds/photos/<species-slug>/photo-file.jpg`

Example:

- `assets/birds/photos/brown-pelican/brown-pelican-01.jpg`
- `assets/birds/photos/brown-pelican/brown-pelican-02.jpg`

## 2) Register the photos in the manifest

Open `assets/js/bird-photos.js` and add entries like:

```js
window.BIRD_PHOTO_MANIFEST = {
  "brown-pelican": ["brown-pelican-01.jpg", "brown-pelican-02.jpg"],
  "northern-cardinal": ["cardinal-yard-01.jpg"]
};
```

## 3) Species slug format

Slug format is lowercase words joined by hyphens:

- `Brown pelican` -> `brown-pelican`
- `Black-bellied whistling-duck` -> `black-bellied-whistling-duck`

## Status logic on the Birds page

- `?` means no photos registered in `bird-photos.js`
- Green dot means photos are registered
- Clicking a species with a green dot opens its gallery page
