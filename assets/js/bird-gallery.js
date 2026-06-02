(function () {
  const titleEl = document.getElementById("bird-title");
  const gridEl = document.getElementById("bird-gallery-grid");
  const emptyEl = document.getElementById("bird-gallery-empty");

  if (!titleEl || !gridEl || !emptyEl) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const slug = (params.get("species") || "").trim();
  const name = (params.get("name") || "Bird").trim();
  const manifest = window.BIRD_PHOTO_MANIFEST || {};
  const files = slug && Array.isArray(manifest[slug]) ? manifest[slug] : [];

  titleEl.textContent = name;

  if (!slug || files.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  gridEl.innerHTML = files
    .map((fileName, index) => {
      const src = `../assets/birds/photos/${slug}/${fileName}`;
      const alt = `${name} photo ${index + 1}`;
      return `
        <figure class="bird-photo-card">
          <img src="${src}" alt="${alt}" loading="lazy" decoding="async" />
          <figcaption>${fileName}</figcaption>
        </figure>
      `;
    })
    .join("");
})();
