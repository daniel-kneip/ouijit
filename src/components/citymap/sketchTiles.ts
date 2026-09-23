import { TH, TW } from './cityGeometry';
import { canvasCaches } from './canvasMemory';

type Ctx = CanvasRenderingContext2D;

const urls = import.meta.glob<string>(
  [
    '../../../assets/tiles/terrain-*/{grass_center,water_center,tree_single,tree_multiple,tree_pine,tree_pineLarge,rocks_grass,tree,trees,rocks}_N.png',
    '../../../assets/tiles/terrain-*/{grass,water}_center_N~*.png',
    '../../../assets/tiles/city-*/{building,roof}_*.png',
  ],
  { eager: true, query: '?url', import: 'default' },
);

function spriteName(path: string): string {
  return /tiles\/([^/]+\/[^/]+)\.png$/.exec(path)?.[1] ?? path;
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
  /** Largest first, each half the one before. */
  levels: HTMLCanvasElement[];
  /** The box below in the 256×352 frame, however large the image was drawn. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const sprites = new Map<string, Sprite>();
let loading: Promise<void> | null = null;

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
  const box = opaqueBox(img);
  const levels: HTMLCanvasElement[] = [];
  let source: CanvasImageSource = img;
  let sx = box.x;
  let sy = box.y;
  let w = box.w;
  let h = box.h;
  let from = { w, h };
  for (;;) {
    const level = document.createElement('canvas');
    level.width = w;
    level.height = h;
    const lctx = level.getContext('2d');
    if (!lctx) return;
    lctx.imageSmoothingQuality = 'high';
    lctx.drawImage(source, sx, sy, from.w, from.h, 0, 0, w, h);
    levels.push(level);
    if (w <= 24) break;
    source = level;
    sx = 0;
    sy = 0;
    from = { w, h };
    w = Math.max(1, Math.round(w / 2));
    h = Math.max(1, Math.round(h / 2));
  }
  const unit = FRAME_W / img.naturalWidth;
  sprites.set(name, { levels, x: box.x * unit, y: box.y * unit, w: box.w * unit, h: box.h * unit });
}

/** Resolves once every tile is decoded; the map draws its own shapes until then. */
export function loadSketchTiles(): Promise<void> {
  loading ??= Promise.all(Object.entries(urls).map(([path, url]) => load(spriteName(path), url))).then(
    (): void => undefined,
  );
  return loading;
}

export function sketchTilesReady(): boolean {
  return sprites.size > 0 && sprites.size === Object.keys(urls).length;
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
  let pick = sprite.levels[0];
  for (const level of sprite.levels) {
    if (level.width < onScreen) break;
    pick = level;
  }
  ctx.drawImage(
    pick,
    cx + (sprite.x - FACE_X) * SCALE_X,
    cy - level * SKETCH_BLOCK + (sprite.y - FACE_Y) * SCALE_Y,
    w,
    h,
  );
}

canvasCaches.add({
  name: 'sketch tiles',
  stats() {
    let bytes = 0;
    for (const { levels } of sprites.values()) for (const c of levels) bytes += c.width * c.height * 4;
    return { entries: sprites.size, bytes };
  },
});
