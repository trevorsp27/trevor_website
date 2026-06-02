(function () {
  const loadingEl = document.getElementById("birds-loading");
  const errorEl = document.getElementById("birds-error");
  const rootEl = document.getElementById("birds-root");

  if (!loadingEl || !errorEl || !rootEl) {
    return;
  }

  const CATALOG_URL = "../assets/birds/birds-catalog.json";
  const MANIFEST_URL = "../assets/birds/photo-manifest.json";

  function hasPhotosForSpecies(speciesId, manifest) {
    return (
      manifest &&
      manifest.speciesPhotos &&
      Array.isArray(manifest.speciesPhotos[speciesId]) &&
      manifest.speciesPhotos[speciesId].length > 0
    );
  }

  function renderSpeciesItem(species, manifest) {
    const hasPhotos = hasPhotosForSpecies(species.id, manifest);
    const markerClass = hasPhotos ? "bird-status ready" : "bird-status missing";
    const markerSymbol = hasPhotos ? "●" : "?";
    const markerLabel = hasPhotos ? "Photos available" : "No photos yet";

    if (hasPhotos) {
      const href = `/pages/bird.html?id=${encodeURIComponent(species.id)}`;
      return `
        <li class="bird-item">
          <span class="${markerClass}" aria-label="${markerLabel}" title="${markerLabel}">${markerSymbol}</span>
          <a class="bird-link" href="${href}">${species.name}</a>
        </li>
      `;
    }

    return `
      <li class="bird-item">
        <span class="${markerClass}" aria-label="${markerLabel}" title="${markerLabel}">${markerSymbol}</span>
        <span class="bird-name">${species.name}</span>
      </li>
    `;
  }

  function renderFamilies(catalog, manifest) {
    rootEl.innerHTML = catalog.families
      .map((family, index) => {
        const familyId = `family-${index + 1}`;
        const familyName = family.name || family.family || "Unknown family";
        const familyHasPhotos = family.species.some((species) =>
          hasPhotosForSpecies(species.id, manifest)
        );
        const familyDot = familyHasPhotos
          ? '<span class="bird-status ready bird-family-dot" aria-label="Family has photos" title="Family has photos">●</span>'
          : "";
        const speciesMarkup = family.species
          .map((species) => renderSpeciesItem(species, manifest))
          .join("");

        return `
          <details class="bird-family" id="${familyId}">
            <summary>
              <span class="bird-family-title">${familyDot}<span>${familyName}</span></span>
              <span class="bird-family-count">${family.species.length} species</span>
            </summary>
            <ul class="bird-species-list">
              ${speciesMarkup}
            </ul>
          </details>
        `;
      })
      .join("");
  }

  Promise.all([fetch(CATALOG_URL), fetch(MANIFEST_URL)])
    .then(async ([catalogResponse, manifestResponse]) => {
      if (!catalogResponse.ok) {
        throw new Error("Catalog request failed");
      }

      if (!manifestResponse.ok) {
        throw new Error("Manifest request failed");
      }

      const catalog = await catalogResponse.json();
      const manifest = await manifestResponse.json();
      if (!catalog || !Array.isArray(catalog.families) || !catalog.families.length) {
        throw new Error("Local bird catalog is missing or invalid");
      }

      renderFamilies(catalog, manifest);
      rootEl.hidden = false;
      loadingEl.hidden = true;
    })
    .catch(() => {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    });
})();
