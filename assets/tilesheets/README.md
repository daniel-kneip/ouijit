# Tile sheets

Kenney's Sketch tiles laid out for redrawing: one sheet per terrain variant
and one per city culture, on flat `#FF00FF` for keying out.

- Every tile sits in its original 256×352 frame, unscaled. The top face of a
  block is centred at (128, 181) and one block stands 110 px, so a redrawn
  tile has to keep its outline in the same place to fit the map's grid.
- Each `*.json` lists the tiles on its sheet with the top-left corner of their
  frame. A redrawn sheet is cut back into tiles by scaling those positions by
  the ratio of its size to the `size` recorded there.
- Terrain sheets show the `N` orientation only; `E`, `S` and `W` are the same
  shapes turned. Variants with no tiles of their own start from the Sketch
  Town grass (`dry` from the Sketch Desert sand).
- City sheets hold each tile twice: the day tiles above, the same tiles toned
  for night below the second rule.

## Redrawn

`redrawn/` holds the sheets as they came back, with their manifests; the
adobe sheet follows the oldtown layout. `scripts/cut-tilesheets.py` cuts them
into `assets/tiles/<sheet>/`, night tiles suffixed `@night`, which is what the
map loads. They come back at a third of the size they went out, so they are
cut with `--upscale` and Real-ESRGAN's `RealESRGAN_x4plus.pth` (from the
Real-ESRGAN releases on GitHub), which keeps their grit where the anime
model flattens it.
