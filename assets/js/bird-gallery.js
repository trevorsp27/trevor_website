(function () {
  const titleEl = document.getElementById("bird-title");
  const viewerEl = document.getElementById("bird-viewer");
  const imageEl = document.getElementById("bird-viewer-image");
  const prevButtonEl = document.getElementById("bird-prev");
  const nextButtonEl = document.getElementById("bird-next");
  const countEl = document.getElementById("bird-viewer-count");
  const emptyEl = document.getElementById("bird-gallery-empty");
  const noteEl = document.getElementById("bird-note");
  const noteTextEl = document.getElementById("bird-note-text");

  if (
    !titleEl ||
    !viewerEl ||
    !imageEl ||
    !prevButtonEl ||
    !nextButtonEl ||
    !countEl ||
    !emptyEl ||
    !noteEl ||
    !noteTextEl
  ) {
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
      const note =
        manifest && manifest.speciesNotes && typeof manifest.speciesNotes[species.id] === "string"
          ? manifest.speciesNotes[species.id].trim()
          : "";

      if (note) {
        noteTextEl.textContent = note;
        noteEl.hidden = false;
      }

      if (!files.length) {
        emptyEl.hidden = false;
        return;
      }

      let currentIndex = 0;

      function renderCurrentPhoto() {
        const fileName = files[currentIndex];
        const src = `../assets/birds/photos/${species.familySlug}/${species.slug}/${fileName}`;
        const alt = `${species.name} photo ${currentIndex + 1}`;

        imageEl.src = src;
        imageEl.alt = alt;
        countEl.textContent = `${currentIndex + 1} / ${files.length}`;

        const hasMultiplePhotos = files.length > 1;
        prevButtonEl.hidden = !hasMultiplePhotos;
        nextButtonEl.hidden = !hasMultiplePhotos;
      }

      function showPrevious() {
        currentIndex = (currentIndex - 1 + files.length) % files.length;
        renderCurrentPhoto();
      }

      function showNext() {
        currentIndex = (currentIndex + 1) % files.length;
        renderCurrentPhoto();
      }

      prevButtonEl.addEventListener("click", showPrevious);
      nextButtonEl.addEventListener("click", showNext);

      document.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") {
          showPrevious();
        }
        if (event.key === "ArrowRight") {
          showNext();
        }
      });

      renderCurrentPhoto();
      viewerEl.hidden = false;
      countEl.hidden = false;
    })
    .catch(() => {
      titleEl.textContent = "Bird photos";
      emptyEl.hidden = false;
    });
})();
