// Resolves a bird photo to its web-sized derivative.
//
// The originals under assets/birds/photos are untouched camera files, several
// megabytes each. scripts/build-bird-web-images.py writes a ~1600px WebP for
// each one under assets/birds/web, and pages load those instead.
//
// If a derivative is missing -- a photo added without re-running the script --
// the image falls back to the original rather than showing a broken frame.
(function () {
  function webSrc(familySlug, slug, fileName) {
    const base = String(fileName).replace(/\.[^.]+$/, "");
    return `../assets/birds/web/${familySlug}/${slug}/${base}.webp`;
  }

  function originalSrc(familySlug, slug, fileName) {
    return `../assets/birds/photos/${familySlug}/${slug}/${fileName}`;
  }

  // Points an <img> at the derivative, with a one-time fallback to the original.
  function setBirdPhoto(imageEl, familySlug, slug, fileName) {
    const fallback = originalSrc(familySlug, slug, fileName);

    imageEl.onerror = function () {
      // Only retry once, or a genuinely missing photo would loop.
      imageEl.onerror = null;
      imageEl.src = fallback;
    };
    imageEl.src = webSrc(familySlug, slug, fileName);
  }

  window.setBirdPhoto = setBirdPhoto;
})();
