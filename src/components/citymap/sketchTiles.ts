import { TW } from './cityGeometry';
import { canvasCaches } from './canvasMemory';

type Ctx = CanvasRenderingContext2D;

const urls = import.meta.glob<string>(
  [
    '../../../assets/Sketch Town/Tiles/{grass_center,grass_pathCrossing,dirt_center}_N.png',
    '../../../assets/Sketch Town/Tiles/grass_path_{N,E}.png',
    '../../../assets/Sketch Town/Tiles/building_{center,window,windows,door,doorWindows}{,Beige}_{N,E}.png',
    '../../../assets/Sketch Town/Tiles/roof_{gable,slant}{Beige,Brown,Green,Purple}_{N,E}.png',
    '../../../assets/Sketch Town/Tiles/roof_{point,rounded,church}{Beige,Brown,Green,Purple}_N.png',
    '../../../assets/Sketch Town/Tiles/tree_{single,multiple}_N.png',
    '../../../assets/Sketch Town Expansion/Tiles/tree_{pine,pineLarge}_N.png',
    '../../../assets/Sketch Desert/Tiles/{grass_center,building_center,dome,dome_small,tree}_N.png',
  ],
  { eager: true, query: '?url', import: 'default' },
);

const PACKS: Record<string, string> = {
  'Sketch Town': 'town',
  'Sketch Town Expansion': 'town',
  'Sketch Desert': 'desert',
};

function spriteName(path: string): string {
  const [, pack, file] = /assets\/([^/]+)\/Tiles\/([^/]+)\.png$/.exec(path) ?? [];
  return `${PACKS[pack]}/${file}`;
}

/**
 * Where a tile's top face is centred in its 256×352 image, and how tall one
 * block of the tile stands. Kenney draws every tile as a block on the same
 * grid, so a roof or a tree is placed as the block above the one it rests on.
 */
const FACE_X = 127.5;
const FACE_Y = 186;
const FACE_HALF_W = 116.5;
const BLOCK_PX = 104;

export const SKETCH_SCALE = TW / FACE_HALF_W;
export const SKETCH_BLOCK = BLOCK_PX * SKETCH_SCALE;

interface Sprite {
  /** Largest first, each half the one before. */
  levels: HTMLCanvasElement[];
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
  sprites.set(name, { levels, ...box });
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

/**
 * Draws a tile with its top face centred on (`cx`, `cy`) raised `level`
 * blocks: ground is level 0, whatever stands on it level 1.
 */
export function drawTile(ctx: Ctx, name: string, cx: number, cy: number, level = 0): void {
  const sprite = sprites.get(name);
  if (!sprite) return;
  const w = sprite.w * SKETCH_SCALE;
  const h = sprite.h * SKETCH_SCALE;
  const m = ctx.getTransform();
  const onScreen = w * Math.hypot(m.a, m.b);
  let pick = sprite.levels[0];
  for (const level of sprite.levels) {
    if (level.width < onScreen) break;
    pick = level;
  }
  ctx.drawImage(
    pick,
    cx + (sprite.x - FACE_X) * SKETCH_SCALE,
    cy - level * SKETCH_BLOCK + (sprite.y - FACE_Y) * SKETCH_SCALE,
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
