"""
Cuts redrawn tile sheets back into tiles for the city map.

    python3 scripts/cut-tilesheets.py assets/tilesheets/redrawn assets/tiles

Needs Pillow, numpy and scipy. Reads each sheet beside its manifest, keys
out the #FF00FF ground, and places every tile in Kenney's 256x352 frame by
fitting its outline to the original tile's, then writes it at half size.
Prints the tiles whose outline still differs from the original's.
"""
import json, os, sys, glob, collections
from PIL import Image
import numpy as np
from scipy import ndimage

A = os.path.join(os.path.dirname(__file__), '..', 'assets')
SRC, OUT = sys.argv[1], sys.argv[2]
W, H = 256, 352
PACKS = ['Sketch Town', 'Sketch Town Expansion', 'Sketch Desert']
DECO = ('tree', 'rocks')

def reference(slug, name):
    for p in (['Sketch Desert'] if slug == 'terrain-dry' else PACKS):
        f = f'{A}/{p}/Tiles/{name}.png'
        if os.path.exists(f): return np.asarray(Image.open(f).convert('RGBA'))[:, :, 3] > 128

def key(rgb):
    rgb = rgb.astype(np.float32)
    m = np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1]
    a = np.clip((210 - m) / 110, 0, 1)
    k = np.array([250, 0, 250], np.float32)
    out = np.clip((rgb - (1 - a[..., None]) * k) / np.maximum(a, 1e-3)[..., None], 0, 255)
    return np.dstack([out, a * 255]).astype(np.uint8)

def bbox(mask):
    ys, xs = np.nonzero(mask)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

def isolate(rgba, fw, fh):
    """Keeps the tile: the largest shape and whatever stands level with it, so labels and rules above drop out."""
    mask = rgba[..., 3] > 100
    lab, n = ndimage.label(mask)
    if n == 0: return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    slices = ndimage.find_objects(lab)
    main = slices[int(np.argmax(sizes))][0]
    keep = np.zeros(n + 1, bool)
    for i, (sz, sl) in enumerate(zip(sizes, slices), 1):
        ys = sl[0]
        overlap = min(ys.stop, main.stop) - max(ys.start, main.start)
        if sz >= 0.04 * sizes.max() and overlap >= 0.5 * (ys.stop - ys.start): keep[i] = True
    solid = keep[lab]
    near = ndimage.binary_dilation(solid, iterations=2)
    out = rgba.astype(np.float32)
    out[..., 3] = np.where(near, out[..., 3], 0)
    edge = near & ndimage.binary_dilation(~solid, iterations=4)
    spill = np.clip(np.minimum(out[..., 0], out[..., 2]) - out[..., 1], 0, None) * edge
    out[..., 0] -= spill
    out[..., 2] -= spill
    rim = solid & ~ndimage.binary_erosion(solid)
    out[..., 3] = np.where(rim, out[..., 3] * 0.5, out[..., 3])
    out[..., 3] = np.where(near & ~solid, 0, out[..., 3])
    return np.clip(out, 0, 255).astype(np.uint8)

def fit(tile, ref, deco):
    """Places the tile's opaque box on the original's: whole box for blocks, bottom centre and height for what stands on them."""
    m = tile[..., 3] > 128
    x0, y0, x1, y1 = bbox(m)
    rx0, ry0, rx1, ry1 = bbox(ref)
    crop = Image.fromarray(tile[y0:y1, x0:x1], 'RGBA').convert('RGBa')
    if deco:
        s = (ry1 - ry0) / (y1 - y0)
        w = max(1, round((x1 - x0) * s)); h = ry1 - ry0
        dx = round((rx0 + rx1) / 2 - w / 2); dy = ry0
    else:
        w, h, dx, dy = rx1 - rx0, ry1 - ry0, rx0, ry0
    frame = Image.new('RGBa', (W, H))
    frame.paste(crop.resize((w, h), Image.LANCZOS), (dx, dy))
    return np.asarray(frame.convert('RGBA'))

report = []
for jf in sorted(glob.glob(f'{SRC}/*.json')):
    slug = os.path.basename(jf)[:-5]
    m = json.load(open(jf))
    sheet = np.asarray(Image.open(f'{SRC}/{m["sheet"]}').convert('RGB'))
    sx = sheet.shape[1] / m['size'][0]; sy = sheet.shape[0] / m['size'][1]
    os.makedirs(f'{OUT}/{slug}', exist_ok=True)
    for t in m['tiles']:
        night = (t['section'] or '').startswith('NIGHT')
        name = t['name']
        pad_y, pad_x = round(20 * sy), round(8 * sx)
        x0 = max(0, round(t['x'] * sx) - pad_x); y0 = max(0, round(t['y'] * sy) - pad_y)
        x1 = round((t['x'] + W) * sx) + pad_x; y1 = round((t['y'] + H) * sy)
        rgba = isolate(key(sheet[y0:y1, x0:x1]), W * sx, H * sy)
        ref = reference(slug, name)
        if rgba is None: report.append((slug, 'night' if night else 'day', name, 0.0)); continue
        big = Image.fromarray(rgba, 'RGBA').convert('RGBa').resize(
            (round(rgba.shape[1] / sx), round(rgba.shape[0] / sy)), Image.LANCZOS).convert('RGBA')
        placed = fit(np.asarray(big), ref, name.startswith(DECO))
        Image.fromarray(placed, 'RGBA').convert('RGBa').resize((W // 2, H // 2), Image.LANCZOS).convert('RGBA').save(
            f'{OUT}/{slug}/{name}{"@night" if night else ""}.png', optimize=True)
        mask = placed[..., 3] > 128
        iou = (mask & ref).sum() / max(1, (mask | ref).sum())
        report.append((slug, 'night' if night else 'day', name, round(float(iou), 2)))
by = collections.defaultdict(list)
for r in report: by[r[0]].append(r)
for slug, rs in by.items():
    bad = [f'{r[2]}{"@n" if r[1]=="night" else ""}:{r[3]}' for r in rs if r[3] < 0.88 and not r[2].startswith(DECO)]
    print(f'{slug:20s} {len(rs)-len(bad):3d}/{len(rs)}  off: {" ".join(bad)}')
