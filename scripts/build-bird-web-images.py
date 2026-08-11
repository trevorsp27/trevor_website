"""Generate web-sized bird photos.

The originals are untouched camera JPEGs: 157 files, 448 MB, up to 9.6 MB and
5184x3456 each, for images the site never displays wider than about 1600px.
This writes one WebP derivative per photo alongside them under assets/birds/web/.

Run after adding photos:

    ./.venv/Scripts/python.exe scripts/build-bird-web-images.py
"""

import os
import sys
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "assets", "birds", "photos")
OUT_DIR = os.path.join(ROOT, "assets", "birds", "web")

MAX_EDGE = 1600
QUALITY = 80
EXTS = (".jpg", ".jpeg", ".png")


def derivatives():
    for dirpath, _dirnames, filenames in os.walk(SRC_DIR):
        for name in sorted(filenames):
            if name.lower().endswith(EXTS):
                yield os.path.join(dirpath, name)


def main():
    force = "--force" in sys.argv
    made = skipped = 0
    src_bytes = out_bytes = 0

    for src in derivatives():
        rel = os.path.relpath(src, SRC_DIR)
        base = os.path.splitext(rel)[0]
        dst = os.path.join(OUT_DIR, base + ".webp")

        src_bytes += os.path.getsize(src)

        # Skip work already done, so re-running after adding one photo is quick.
        if not force and os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            out_bytes += os.path.getsize(dst)
            skipped += 1
            continue

        os.makedirs(os.path.dirname(dst), exist_ok=True)

        # Phone and camera files carry an orientation flag that has to be baked
        # in, or half the gallery ends up sideways.
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        im.save(dst, "WEBP", quality=QUALITY, method=5)

        out_bytes += os.path.getsize(dst)
        made += 1
        print(f"  {base}.webp  {os.path.getsize(dst) // 1024} KB")

    mb = lambda b: f"{b / 1048576:.1f} MB"
    print(
        f"\n{made} generated, {skipped} already current\n"
        f"originals {mb(src_bytes)} -> web {mb(out_bytes)}"
        + (f"  ({src_bytes / out_bytes:.0f}x smaller)" if out_bytes else "")
    )


if __name__ == "__main__":
    main()
