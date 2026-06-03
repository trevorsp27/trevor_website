(function () {
  const loadingEl = document.getElementById("birds-loading");
  const errorEl = document.getElementById("birds-error");
  const rootEl = document.getElementById("birds-root");
  const featuredRootEl = document.getElementById("featured-bird");
  const featuredEmptyEl = document.getElementById("featured-bird-empty");
  const featuredImageEl = document.getElementById("featured-bird-image");
  const featuredNameEl = document.getElementById("featured-bird-name");
  const featuredLinkEl = document.getElementById("featured-bird-link");
  const featuredOpenEl = document.getElementById("featured-bird-open");
  const speciesProgressEl = document.getElementById("species-progress");

  if (!loadingEl || !errorEl || !rootEl) {
    return;
  }

  const CATALOG_URL = "../assets/birds/birds-catalog.json";
  const MANIFEST_URL = "../assets/birds/photo-manifest.json";

  function buildGalleryHref(speciesId) {
    return `/pages/bird.html?id=${encodeURIComponent(speciesId)}`;
  }

  function renderFeaturedBird(catalog, manifest) {
    if (
      !featuredRootEl ||
      !featuredEmptyEl ||
      !featuredImageEl ||
      !featuredNameEl ||
      !featuredLinkEl ||
      !featuredOpenEl
    ) {
      return;
    }

    const allSpecies = (catalog.families || []).flatMap((family) => family.species || []);
    const withPhotos = allSpecies
      .filter(
        (species) =>
          manifest &&
          manifest.speciesPhotos &&
          Array.isArray(manifest.speciesPhotos[species.id]) &&
          manifest.speciesPhotos[species.id].length > 0
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    if (!withPhotos.length) {
      featuredEmptyEl.hidden = false;
      featuredRootEl.hidden = true;
      return;
    }

    const daySeed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
    const speciesIndex = daySeed % withPhotos.length;
    const species = withPhotos[speciesIndex];
    const files = manifest.speciesPhotos[species.id];
    const fileIndex = daySeed % files.length;
    const fileName = files[fileIndex];
    const photoSrc = `../assets/birds/photos/${species.familySlug}/${species.slug}/${fileName}`;
    const galleryHref = buildGalleryHref(species.id);

    featuredImageEl.src = photoSrc;
    featuredImageEl.alt = `${species.name} featured photo`;
    featuredNameEl.textContent = species.name;
    featuredLinkEl.href = galleryHref;
    featuredOpenEl.href = galleryHref;

    featuredEmptyEl.hidden = true;
    featuredRootEl.hidden = false;
  }

  function renderSpeciesProgress(catalog, manifest) {
    if (!speciesProgressEl) {
      return;
    }

    const allSpecies = (catalog.families || []).flatMap((family) => family.species || []);
    const totalSpecies = allSpecies.length;
    const photographedSpecies = allSpecies.filter((species) =>
      hasPhotosForSpecies(species.id, manifest)
    ).length;

    speciesProgressEl.textContent = `Species photographed: ${photographedSpecies} / ${totalSpecies}`;
  }

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
    const markerSymbol = "●";
    const markerLabel = hasPhotos ? "Photos available" : "No photos yet";

    if (hasPhotos) {
      const href = buildGalleryHref(species.id);
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
        const photographedCount = family.species.filter((species) =>
          hasPhotosForSpecies(species.id, manifest)
        ).length;
        const totalCount = family.species.length;

        let familyDot = "";
        if (photographedCount === 0) {
          familyDot =
            '<span class="bird-status missing bird-family-dot" aria-label="Family has no photos" title="Family has no photos">●</span>';
        }

        if (photographedCount > 0 && photographedCount < totalCount) {
          familyDot =
            '<span class="bird-status partial bird-family-dot" aria-label="Family partially photographed" title="Family partially photographed">●</span>';
        }

        if (photographedCount > 0 && photographedCount === totalCount) {
          familyDot =
            '<span class="bird-status ready bird-family-dot" aria-label="Family fully photographed" title="Family fully photographed">●</span>';
        }

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

  Promise.all([
    fetch(CATALOG_URL, { cache: "no-store" }),
    fetch(MANIFEST_URL, { cache: "no-store" })
  ])
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

      renderFeaturedBird(catalog, manifest);
      renderSpeciesProgress(catalog, manifest);
      renderFamilies(catalog, manifest);
      rootEl.hidden = false;
      loadingEl.hidden = true;
    })
    .catch(() => {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    });
})();
