#!/usr/bin/env python3
"""
One-time prep of the horse mark (needs Pillow). Turns the owner's drawing (horse-source.jpg, dark
lines on white) into the two coverage masks design/icons.mjs renders from:

  horse.png       1024x1024 8-bit grayscale, 255 = line, 0 = empty; for icons 128 px and up
  horse-bold.png  the same lines thickened, so they stay visible at favicon sizes (16-64 px)

Re-run only when the source drawing changes:  python3 design/mark/prepare.py && node design/icons.mjs
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
src = np.asarray(Image.open(HERE / "horse-source.jpg").convert("L")).astype(float)
# White paper (~255) -> 0, ink (~65) -> 1, with a soft ramp for the anti-aliased edges.
cov = np.clip((235.0 - src) / (235.0 - 70.0), 0.0, 1.0)
ys, xs = np.where(cov > 0.2)
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
half = max(xs.max() - xs.min(), ys.max() - ys.min()) / 2
box = (int(cx - half), int(cy - half), int(cx + half) + 1, int(cy + half) + 1)
mask = Image.fromarray((cov * 255).astype("uint8")).crop(box).resize((1024, 1024), Image.LANCZOS)
mask.save(HERE / "horse.png", optimize=True)
mask.filter(ImageFilter.MaxFilter(25)).filter(ImageFilter.GaussianBlur(2)).save(HERE / "horse-bold.png", optimize=True)
print("wrote horse.png, horse-bold.png")
