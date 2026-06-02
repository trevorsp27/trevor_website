(function () {
  const titleEl = document.getElementById("bird-title");
  const gridEl = document.getElementById("bird-gallery-grid");
  const emptyEl = document.getElementById("bird-gallery-empty");

  if (!titleEl || !gridEl || !emptyEl) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const speciesId = (params.get("id") || "").trim();

  if (!speciesId) {
    titleEl.textContent = "Bird photos";
    emptyEl.hidden = false;
    return;
  }

  Promise.all([
    fetch("../assets/birds/birds-catalog.json", { cache: "no-store" }),
    fetch("../assets/birds/photo-manifest.json", { cache: "no-store" })
  ])
    .then(async ([catalogResponse, manifestResponse]) => {
      if (!catalogResponse.ok || !manifestResponse.ok) {
        throw new Error("Failed to load local bird assets");
      }

      const catalog = await catalogResponse.json();
      const manifest = await manifestResponse.json();
      const allSpecies = (catalog.families || []).flatMap((family) => family.species || []);
      const species = allSpecies.find((entry) => entry.id === speciesId);

      if (!species) {
        titleEl.textContent = "Bird photos";
        emptyEl.hidden = false;
        return;
      }

      titleEl.textContent = species.name;
      const files =
        manifest && manifest.speciesPhotos && Array.isArray(manifest.speciesPhotos[species.id])
          ? manifest.speciesPhotos[species.id]
          : [];

      if (!files.length) {
        emptyEl.hidden = false;
        return;
      }

      gridEl.innerHTML = files
        .map((fileName, index) => {
          const src = `../assets/birds/photos/${species.familySlug}/${species.slug}/${fileName}`;
          const alt = `${species.name} photo ${index + 1}`;
          return `
            <figure class="bird-photo-card">
              <img src="${src}" alt="${alt}" loading="lazy" decoding="async" />
              <figcaption>${fileName}</figcaption>
            </figure>
          `;
        })
        .join("");
    })
    .catch(() => {
      titleEl.textContent = "Bird photos";
      emptyEl.hidden = false;
    });
})();
