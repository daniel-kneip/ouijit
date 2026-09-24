"""
Cuts redrawn tile sheets back into tiles for the city map.

    python3 scripts/cut-tilesheets.py assets/tilesheets/redrawn assets/tiles [--upscale RealESRGAN_x4plus.pth]

Needs Pillow, numpy and scipy; --upscale also torch and spandrel. Reads each
sheet beside its manifest, keys out the sheet's ground colour (meant to be
#FF00FF), and places every tile in Kenney's 256x352 frame by fitting its
outline to the original tile's, then writes it as WebP. Sheets come back from
the image model far smaller than they went out; --upscale runs a
super-resolution model over each first, and keeps the result in
~/.cache/ouijit-tilesheets so a second cut does not pay for it again.
A terrain's full ground and water tiles lose the rim of their top face and
come in four turns, `~1` to `~3` beside the first.
A tile with a `ref` in the manifest is a variant, fitted to and treated as
that original.
Prints the tiles whose outline still differs from the original's.
"""
import json, os, sys, glob, collections
from PIL import Image, ImageDraw, ImageOps
import numpy as np
from scipy import ndimage

A = os.path.join(os.path.dirname(__file__), '..', 'assets')
SRC, OUT = sys.argv[1], sys.argv[2]
MODEL = sys.argv[sys.argv.index('--upscale') + 1] if '--upscale' in sys.argv else None
CACHE = os.path.expanduser('~/.cache/ouijit-tilesheets')
W, H = 256, 352
PACKS = ['Sketch Town', 'Sketch Town Expansion', 'Sketch Desert']
DECO = ('tree', 'rocks')

def reference(slug, name):
    for p in (['Sketch Desert'] if slug == 'terrain-dry' else PACKS):
        f = f'{A}/{p}/Tiles/{name}.png'
        if os.path.exists(f): return np.asarray(Image.open(f).convert('RGBA'))[:, :, 3] > 128

def background(sheet):
    """The sheet's ground colour: the commonest colour, which is whatever the tiles stand on, magenta or not."""
    px = sheet[::4, ::4].reshape(-1, 3)
    bins = (px // 16).astype(np.int32)
    ids = bins[:, 0] * 256 + bins[:, 1] * 16 + bins[:, 2]
    common = np.bincount(ids).argmax()
    return px[ids == common].astype(np.float32).mean(axis=0)

def key(rgb, k):
    rgb = rgb.astype(np.float32)
    a = np.clip((np.linalg.norm(rgb - k, axis=-1) - 45) / 70, 0, 1)
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

FACE = (128, 181, 116, 55)
FACE_INSET = 0.18
SEAMLESS = ('grass_center_N', 'water_center_N')

def seamless(tile):
    """The block with its top face cut in from the rim and stretched back to the grid's diamond, so neighbours meet without a line; four ways round, which the diamond allows."""
    cx, cy, hw, hh = FACE
    k = 1 - FACE_INSET
    inner = tile.crop((round(cx - hw * k), round(cy - hh * k), round(cx + hw * k), round(cy + hh * k)))
    size = (2 * hw + 2, 2 * hh + 2)
    top = inner.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).polygon([(hw + 1, 0), (2 * hw + 2, hh + 1), (hw + 1, 2 * hh + 2), (0, hh + 1)], fill=255)
    out = []
    for turned in (top, ImageOps.mirror(top), ImageOps.flip(top), top.rotate(180)):
        block = tile.copy()
        block.paste(turned, (cx - hw - 1, cy - hh - 1), mask)
        out.append(block)
    return out

def save(img, path):
    img.save(path, 'WEBP', quality=90, method=6)

def upscaled(path):
    import hashlib
    digest = hashlib.sha1(open(path, 'rb').read() + os.path.basename(MODEL).encode()).hexdigest()[:16]
    cached = os.path.join(CACHE, f'{digest}.png')
    if os.path.exists(cached): return Image.open(cached).convert('RGB')
    import torch
    from spandrel import ModelLoader
    model = ModelLoader().load_from_file(MODEL).eval()
    x = torch.from_numpy(np.asarray(Image.open(path).convert('RGB'), np.float32) / 255).permute(2, 0, 1)[None]
    _, _, h, w = x.shape
    k, tile, pad = model.scale, 256, 16
    out = torch.zeros(1, 3, h * k, w * k)
    with torch.no_grad():
        for y0 in range(0, h, tile):
            for x0 in range(0, w, tile):
                ya, xa, y1, x1 = max(0, y0 - pad), max(0, x0 - pad), min(h, y0 + tile), min(w, x0 + tile)
                r = model(x[:, :, ya:min(h, y1 + pad), xa:min(w, x1 + pad)])
                out[:, :, y0 * k:y1 * k, x0 * k:x1 * k] = r[:, :, (y0 - ya) * k:(y1 - ya) * k, (x0 - xa) * k:(x1 - xa) * k]
    img = Image.fromarray((out[0].clamp(0, 1).permute(1, 2, 0).numpy() * 255 + 0.5).astype(np.uint8))
    os.makedirs(CACHE, exist_ok=True)
    img.save(cached)
    return img

report = []
for jf in sorted(glob.glob(f'{SRC}/*.json')):
    slug = os.path.basename(jf)[:-5]
    m = json.load(open(jf))
    path = f'{SRC}/{m["sheet"]}'
    sheet = np.asarray(upscaled(path) if MODEL else Image.open(path).convert('RGB'))
    sx = sheet.shape[1] / m['size'][0]; sy = sheet.shape[0] / m['size'][1]
    ground = background(sheet)
    os.makedirs(f'{OUT}/{slug}', exist_ok=True)
    for t in m['tiles']:
        night = (t['section'] or '').startswith('NIGHT')
        name = t['name']
        original = t.get('ref', name)
        pad_y, pad_x = round(20 * sy), round(8 * sx)
        x0 = max(0, round(t['x'] * sx) - pad_x); y0 = max(0, round(t['y'] * sy) - pad_y)
        x1 = round((t['x'] + W) * sx) + pad_x; y1 = round((t['y'] + H) * sy) + pad_y
        rgba = isolate(key(sheet[y0:y1, x0:x1], ground), W * sx, H * sy)
        ref = reference(slug, original)
        if rgba is None: report.append((slug, 'night' if night else 'day', name, 0.0)); continue
        top = int(np.nonzero((rgba[..., 3] > 100).any(axis=1))[0][0])
        rgba[top + round((bbox(ref)[3] - bbox(ref)[1]) * sy * 1.04):, :, 3] = 0
        big = Image.fromarray(rgba, 'RGBA').convert('RGBa').resize(
            (round(rgba.shape[1] / sx), round(rgba.shape[0] / sy)), Image.LANCZOS).convert('RGBA')
        placed = fit(np.asarray(big), ref, original.startswith(DECO))
        suffix = '@night' if night else ''
        if slug.startswith('terrain-') and original in SEAMLESS:
            for n, block in enumerate(seamless(Image.fromarray(placed, 'RGBA'))):
                save(block, f'{OUT}/{slug}/{name}{f"~{n}" if n else ""}{suffix}.webp')
        else:
            save(Image.fromarray(placed, 'RGBA'), f'{OUT}/{slug}/{name}{suffix}.webp')
        mask = placed[..., 3] > 128
        iou = (mask & ref).sum() / max(1, (mask | ref).sum())
        report.append((slug, 'night' if night else 'day', name, round(float(iou), 2)))
by = collections.defaultdict(list)
for r in report: by[r[0]].append(r)
for slug, rs in by.items():
    bad = [f'{r[2]}{"@n" if r[1]=="night" else ""}:{r[3]}' for r in rs if r[3] < 0.88 and not r[2].startswith(DECO)]
    print(f'{slug:20s} {len(rs)-len(bad):3d}/{len(rs)}  off: {" ".join(bad)}')
