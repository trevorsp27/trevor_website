(function () {
  const loadingEl = document.getElementById("birds-loading");
  const errorEl = document.getElementById("birds-error");
  const rootEl = document.getElementById("birds-root");

  if (!loadingEl || !errorEl || !rootEl) {
    return;
  }

  const PHOTO_MANIFEST = window.BIRD_PHOTO_MANIFEST || {};
  const WIKI_API_URL =
    "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_birds_of_Louisiana&prop=text&formatversion=2&format=json&origin=*";
  const STOP_TITLES = new Set(["See also", "Notes", "References", "External links"]);

  function normalizeHeadingText(rawText) {
    return rawText.replace(/\[edit\]/gi, "").replace(/\s+/g, " ").trim();
  }

  function slugifyBirdName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function decodeHtml(value) {
    const parser = new DOMParser();
    return parser.parseFromString(value, "text/html").documentElement.textContent || value;
  }

  function parseBirdFamilies(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const contentRoot = doc.querySelector(".mw-parser-output") || doc.body;
    const families = [];
    let currentFamily = null;

    Array.from(contentRoot.children).forEach((node) => {
      if (node.tagName === "H2") {
        const title = normalizeHeadingText(node.textContent || "");
        if (STOP_TITLES.has(title)) {
          currentFamily = null;
          return;
        }

        currentFamily = {
          family: title,
          species: []
        };
        families.push(currentFamily);
        return;
      }

      if (!currentFamily || node.tagName !== "UL") {
        return;
      }

      const items = node.querySelectorAll(":scope > li");
      items.forEach((item) => {
        const link = item.querySelector("a");
        if (!link) {
          return;
        }

        const name = decodeHtml(link.textContent || "").trim();
        if (!name) {
          return;
        }

        const slug = slugifyBirdName(name);
        currentFamily.species.push({
          name,
          slug
        });
      });
    });

    return families.filter((family) => family.species.length > 0);
  }

  function hasPhotosForSpecies(slug) {
    return Array.isArray(PHOTO_MANIFEST[slug]) && PHOTO_MANIFEST[slug].length > 0;
  }

  function renderSpeciesItem(species) {
    const hasPhotos = hasPhotosForSpecies(species.slug);
    const markerClass = hasPhotos ? "bird-status ready" : "bird-status missing";
    const markerSymbol = hasPhotos ? "●" : "?";
    const markerLabel = hasPhotos ? "Photos available" : "No photos yet";

    if (hasPhotos) {
      const href = `/pages/bird.html?species=${encodeURIComponent(species.slug)}&name=${encodeURIComponent(
        species.name
      )}`;
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

  function renderFamilies(families) {
    rootEl.innerHTML = families
      .map((family, index) => {
        const familyId = `family-${index + 1}`;
        const speciesMarkup = family.species.map(renderSpeciesItem).join("");

        return `
          <details class="bird-family" id="${familyId}">
            <summary>
              <span>${family.family}</span>
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

  fetch(WIKI_API_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error("Wikipedia request failed");
      }
      return response.json();
    })
    .then((payload) => {
      const html = payload && payload.parse && payload.parse.text;
      if (!html) {
        throw new Error("Wikipedia payload missing parsed text");
      }

      const families = parseBirdFamilies(html);
      if (!families.length) {
        throw new Error("No families found in parsed bird list");
      }

      renderFamilies(families);
      rootEl.hidden = false;
      loadingEl.hidden = true;
    })
    .catch(() => {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    });
})();
