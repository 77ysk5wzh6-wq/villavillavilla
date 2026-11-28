"""Replace selected PDF spreads with 2880px-wide, lossless book faces.

Requires Poppler (pdfinfo/pdftoppm) and Pillow. Reads the existing manifest so
page order, source PDF page numbers, covers, and other images stay intact.
Usage: python render_text_pages.py /path/to/original.pdf
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pdf", type=Path)
parser.add_argument("--pages", default="5,7,8,10,24,38,50,61")
parser.add_argument("--width", type=int, default=2880)
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent.parent / "noslop-book-assets")
args = parser.parse_args()
pages = sorted({int(n) for n in args.pages.split(",")})
if args.width < 1440:
    parser.error("Use a width of at least 1440 pixels")
manifest_path = args.output / "manifest.json"
manifest = json.loads(manifest_path.read_text())
source_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
if any(n < 1 or n > manifest["pdfPages"] for n in pages):
    parser.error("Requested PDF page is outside the current edition")
import unicodedata
if unicodedata.normalize("NFC", args.pdf.name) != unicodedata.normalize("NFC", manifest["source"]):
    parser.error("The PDF must match the current edition's source")
edition = Path("editions") / f"text-{args.width}-{source_hash[:10]}-v1"
(args.output / edition).mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="villa-text-render-") as temp:
    for number in pages:
        faces = [f for f in manifest["faces"] if f["pdfPage"] == number]
        if not faces:
            raise ValueError(f"No book faces map to PDF page {number}")
        spread = len(faces) == 2
        prefix = Path(temp) / f"pdf-{number:03}"
        subprocess.run([
            "pdftoppm", "-f", str(number), "-l", str(number), "-singlefile",
            "-scale-to-x", str(args.width * (2 if spread else 1)), "-scale-to-y", "-1",
            "-png", str(args.pdf), str(prefix),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with Image.open(prefix.with_suffix(".png")) as rendered:
            for face in faces:
                if spread:
                    mid = rendered.width // 2
                    box = (0, 0, mid, rendered.height) if face["half"] == "left" else (mid, 0, rendered.width, rendered.height)
                else:
                    box = (0, 0, rendered.width, rendered.height)
                image = rendered.crop(box).convert("RGB")
                name = edition / f"pdf-{number:03}-{face['half']}.webp"
                image.save(args.output / name, "WEBP", lossless=True, method=6)
                with Image.open(args.output / name) as check:
                    if check.size != image.size or check.tobytes() != image.tobytes():
                        raise ValueError(f"Lossless verification failed: {name}")
                face.setdefault("previewSrc", face["src"])
                face.update(src=name.as_posix(), width=image.width, height=image.height)
                print(f"PDF {number}, {face['half']}: {image.width}×{image.height}", flush=True)

manifest["highResolution"] = {
    "pdfPages": pages, "faceWidth": args.width, "encoding": "lossless-webp", "sourceSha256": source_hash,
}
for face in manifest["faces"]:
    if not (args.output / face["src"]).is_file():
        raise FileNotFoundError(face["src"])
temporary = manifest_path.with_suffix(".json.tmp")
temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
temporary.replace(manifest_path)
print(f"Updated {len(pages)} PDF pages; original page order and covers preserved.")
