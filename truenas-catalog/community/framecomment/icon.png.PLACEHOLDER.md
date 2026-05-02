# icon.png — placeholder

Replace this with a real **256×256 PNG** logo for FrameComment before
publishing the catalog.

A working SVG version is provided alongside as `icon.svg` and is referenced
from `catalog.json` and `app.yaml` for now. TrueNAS SCALE can use either.

Quick way to generate a PNG from the SVG:

    rsvg-convert -w 256 -h 256 icon.svg > icon.png

or with ImageMagick:

    convert -background none -resize 256x256 icon.svg icon.png
