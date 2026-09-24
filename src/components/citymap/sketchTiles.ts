import { TH, TW } from './cityGeometry';
import { canvasCaches } from './canvasMemory';

type Ctx = CanvasRenderingContext2D;

const urls = import.meta.glob<string>(
  [
    '../../../assets/tiles/terrain-*/{grass_center,water_center,tree_single,tree_multiple,tree_pine,tree_pineLarge,rocks_grass,tree,trees,rocks}_N.webp',
    '../../../assets/tiles/terrain-*/{grass,water}_center_N~*.webp',
    '../../../assets/tiles/city-*/{building,roof}_*.webp',
  ],
  { eager: true, query: '?url', import: 'default' },
);

function spriteName(path: string): string {
  return /tiles\/([^/]+\/[^/]+)\.webp$/.exec(path)?.[1] ?? path;
}

/**
 * Tiles are drawn in Kenney's frame: 256×352 on a 232×110 isometric grid, a
 * block's top face centred at (128, 181) and one block 110 high. An image
 * at another size is that frame scaled.
 * Our lattice is exactly 2:1, so the two axes scale apart to keep neighbouring
 * tiles flush.
 */
const FACE_X = 128;
const FACE_Y = 181;
const GRID_HALF_W = 116;
const GRID_HALF_H = 55;
const BLOCK_PX = 110;
const FRAME_W = 256;

const SCALE_X = TW / GRID_HALF_W;
const SCALE_Y = TH / GRID_HALF_H;
export const SKETCH_BLOCK = BLOCK_PX * SCALE_Y;

interface Sprite {
  /** Drawn from when zoomed in; the browser holds its decoded pixels and may drop them. */
  image: HTMLImageElement;
  /** The opaque part of `image`, in its own pixels. */
  crop: { x: number; y: number; w: number; h: number };
  /** Half the crop and smaller, each half the one before. */
  levels: HTMLCanvasElement[];
  /** The opaque part in the 256×352 frame, however large the image was drawn. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const sprites = new Map<string, Sprite>();
let loading: Promise<string[]> | null = null;
let settled = false;

function opaqueBox(img: HTMLImageElement): { x: number; y: number; w: number; h: number } {
  const probe = document.createElement('canvas');
  probe.width = img.naturalWidth;
  probe.height = img.naturalHeight;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  if (!pctx) return { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  pctx.drawImage(img, 0, 0);
  const { data, width, height } = pctx.getImageData(0, 0, probe.width, probe.height);
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  probe.width = 0;
  probe.height = 0;
  return x1 < x0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function load(name: string, url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const crop = opaqueBox(img);
  const levels: HTMLCanvasElement[] = [];
  let source: CanvasImageSource = img;
  let from = crop;
  for (
    let w = Math.round(crop.w / 2), h = Math.round(crop.h / 2);
    w >= 12;
    w = Math.round(w / 2), h = Math.round(h / 2)
  ) {
    const level = document.createElement('canvas');
    level.width = w;
    level.height = Math.max(1, h);
    const lctx = level.getContext('2d');
    if (!lctx) break;
    lctx.imageSmoothingQuality = 'high';
    lctx.drawImage(source, from.x, from.y, from.w, from.h, 0, 0, level.width, level.height);
    levels.push(level);
    source = level;
    from = { x: 0, y: 0, w: level.width, h: level.height };
  }
  const unit = FRAME_W / img.naturalWidth;
  sprites.set(name, {
    image: img,
    crop,
    levels,
    x: crop.x * unit,
    y: crop.y * unit,
    w: crop.w * unit,
    h: crop.h * unit,
  });
}

/**
 * Decodes every tile and resolves with the paths of any that would not load;
 * the map draws its own shapes until this settles, and leaves those out after.
 */
export function loadSketchTiles(): Promise<string[]> {
  loading ??= Promise.allSettled(Object.entries(urls).map(([path, url]) => load(spriteName(path), url))).then(
    (results) => {
      settled = true;
      return Object.keys(urls).filter((_, k) => results[k].status === 'rejected');
    },
  );
  return loading;
}

export function sketchTilesReady(): boolean {
  return settled && sprites.size > 0;
}

export function hasTile(name: string): boolean {
  return sprites.has(name);
}

/**
 * Draws a tile with its top face centred on (`cx`, `cy`) raised `level`
 * blocks: ground is level 0, whatever stands on it level 1.
 */
export function drawTile(ctx: Ctx, name: string, cx: number, cy: number, level = 0): void {
  const sprite = sprites.get(name);
  if (!sprite) return;
  const w = sprite.w * SCALE_X;
  const h = sprite.h * SCALE_Y;
  const m = ctx.getTransform();
  const onScreen = w * Math.hypot(m.a, m.b);
  const x = cx + (sprite.x - FACE_X) * SCALE_X;
  const y = cy - level * SKETCH_BLOCK + (sprite.y - FACE_Y) * SCALE_Y;
  let pick: HTMLCanvasElement | undefined;
  for (const candidate of sprite.levels) {
    if (candidate.width < onScreen) break;
    pick = candidate;
  }
  if (pick) ctx.drawImage(pick, x, y, w, h);
  else ctx.drawImage(sprite.image, sprite.crop.x, sprite.crop.y, sprite.crop.w, sprite.crop.h, x, y, w, h);
}

canvasCaches.add({
  name: 'sketch tiles',
  stats() {
    let bytes = 0;
    for (const { levels } of sprites.values()) for (const c of levels) bytes += c.width * c.height * 4;
    return { entries: sprites.size, bytes };
  },
});
