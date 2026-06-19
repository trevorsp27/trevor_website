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
      let currentZoom = 1;
      let currentTx = 0;
      let currentTy = 0;
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartTx = 0;
      let dragStartTy = 0;
      const minZoom = 1;
      const maxZoom = 5;

      function resetZoom() {
        currentZoom = 1;
        currentTx = 0;
        currentTy = 0;
        imageEl.style.transform = '';
        const photoStage = imageEl.parentElement;
        photoStage.classList.remove('zoomed');
        photoStage.scrollLeft = 0;
        photoStage.scrollTop = 0;
      }

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
        resetZoom();
      }

      function showPrevious() {
        currentIndex = (currentIndex - 1 + files.length) % files.length;
        renderCurrentPhoto();
      }

      function showNext() {
        currentIndex = (currentIndex + 1) % files.length;
        renderCurrentPhoto();
      }
      function applyTransform() {
        imageEl.style.transform = `translate(${currentTx}px, ${currentTy}px) scale(${currentZoom})`;
      }

      function handleZoom(event) {
        event.preventDefault();
        const photoStage = imageEl.parentElement;
        const rect = photoStage.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        const zoomDelta = event.deltaY > 0 ? 0.85 : 1.15;
        const newZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom * zoomDelta));

        if (newZoom === currentZoom) {
          return;
        }

        // set transform-origin so scaling centers at cursor
        imageEl.style.transformOrigin = `${(x / rect.width) * 100}% ${(y / rect.height) * 100}%`;

        // adjust translate so the point under cursor stays roughly fixed
        const prevZoom = currentZoom;
        currentZoom = newZoom;

        // When zooming, scale current translation proportionally
        currentTx = currentTx * (currentZoom / prevZoom);
        currentTy = currentTy * (currentZoom / prevZoom);

        // small nudge so the cursor-centered point stays nearer the cursor
        const dx = (x - rect.width / 2) * (1 - currentZoom / prevZoom) * 0.2;
        const dy = (y - rect.height / 2) * (1 - currentZoom / prevZoom) * 0.2;
        currentTx += dx;
        currentTy += dy;

        applyTransform();

        if (currentZoom > 1) {
          photoStage.classList.add('zoomed');
        } else {
          photoStage.classList.remove('zoomed');
          currentTx = 0;
          currentTy = 0;
          applyTransform();
        }
      }

      
      prevButtonEl.addEventListener("click", showPrevious);
      nextButtonEl.addEventListener("click", showNext);
      const photoStage = imageEl.parentElement;
      photoStage.addEventListener("wheel", handleZoom, { passive: false });
      imageEl.addEventListener("wheel", handleZoom, { passive: false });

      // pointer-based panning when zoomed
      photoStage.addEventListener('pointerdown', (e) => {
        if (currentZoom <= 1) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartTx = currentTx;
        dragStartTy = currentTy;
        photoStage.classList.add('dragging');
        photoStage.setPointerCapture(e.pointerId);
      });

      photoStage.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        currentTx = dragStartTx + dx;
        currentTy = dragStartTy + dy;
        applyTransform();
      });

      const endDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        photoStage.classList.remove('dragging');
        try { photoStage.releasePointerCapture(e.pointerId); } catch (err) {}
      };

      photoStage.addEventListener('pointerup', endDrag);
      photoStage.addEventListener('pointercancel', endDrag);

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
