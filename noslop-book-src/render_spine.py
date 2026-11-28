"""Extract the spine from the supplied print-cover PDF without retyping artwork.

Requires PyMuPDF, Pillow and Poppler. The original PDF remains read-only.
Usage: python render_spine.py /path/to/윤영익_표지(수정).pdf
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

import pymupdf
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pdf", type=Path)
parser.add_argument("--height", type=int, default=3770)
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent.parent / "noslop-book-assets")
args = parser.parse_args()
source_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
doc = pymupdf.open(args.pdf)
page = doc[0]
middle = page.rect.width / 2
images = [pymupdf.Rect(image["bbox"]) for image in page.get_image_info()
          if image["bbox"][3] - image["bbox"][1] > page.rect.height * .9
          and page.rect.width * .4 < image["bbox"][2] - image["bbox"][0] < page.rect.width * .5]
left = max((box for box in images if box.x1 < middle), key=lambda box: box.x1)
right = min((box for box in images if box.x0 > middle), key=lambda box: box.x0)
# The gap between the two trimmed cover images is the printed spine.
crop = pymupdf.Rect(left.x1, max(left.y0, right.y0), right.x0, min(left.y1, right.y1))
if not 0 < crop.width < page.rect.width * .05:
    raise ValueError("Could not identify the spine between the two covers")
# Avoid the adjacent cover photograph leaking into the last rounded raster
# column. This sub-0.1mm inset stays entirely within the white spine margins.
crop.x0 += .2
crop.x1 -= .2
edition = Path("editions") / f"spine-{source_hash[:10]}-v1"
(args.output / edition).mkdir(parents=True, exist_ok=True)
target = edition / "spine.webp"
with tempfile.TemporaryDirectory(prefix="villa-spine-") as temporary:
    temporary = Path(temporary)
    page.set_cropbox(crop)
    doc.save(temporary / "spine.pdf")
    subprocess.run(["pdftoppm", "-cropbox", "-singlefile", "-scale-to-y", str(args.height),
                    "-scale-to-x", "-1", "-png", str(temporary / "spine.pdf"), str(temporary / "spine")],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    with Image.open(temporary / "spine.png") as rendered:
        image = rendered.convert("RGB")
        image.save(args.output / target, "WEBP", lossless=True, method=6)
        with Image.open(args.output / target) as check:
            if check.size != image.size or check.tobytes() != image.tobytes():
                raise ValueError("Lossless image verification failed")
        width, height = image.size
doc.close()
path = args.output / "manifest.json"
manifest = json.loads(path.read_text())
manifest["spine"] = {"src": target.as_posix(), "width": width, "height": height,
                     "source": args.pdf.name, "pdfPage": 1, "cropPoints": list(crop), "sourceSha256": source_hash}
temporary_manifest = path.with_suffix(".json.tmp")
temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
temporary_manifest.replace(path)
print(f"Spine: {width} × {height}, lossless WebP; source crop {tuple(crop)}")
