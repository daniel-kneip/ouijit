import type { District } from '../../stores/cityMapStore';
import { TH, TW, hash2, type Point } from './cityGeometry';
import { tree, type MapTokens } from './drawCity';
import { cellOf, groundColour, terrainCell, underCity, type TerrainCell } from './terrain';

type Ctx = CanvasRenderingContext2D;

interface Visible {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const ZOOM_BUCKETS = [0.5, 1, 2];

/** Cells per chunk side: fewer at a finer scale, so a chunk is about a megabyte whatever the zoom. */
function chunkCells(scale: number): number {
  return Math.round(16 / scale);
}

/**
 * Chunk bitmaps, least recently used first out, held to a byte budget rather
 * than a count: a 4K window zoomed right out shows a few hundred chunks, and a
 * count cap below that repaints the edge of the view on every frame.
 */
class ChunkCache {
  private entries = new Map<string, HTMLCanvasElement>();
  private bytes = 0;
  private fingerprint = '';

  constructor(private budget: number) {}

  /** Drops everything when the world it was painted for has changed. */
  reset(fingerprint: string): void {
    if (fingerprint === this.fingerprint) return;
    this.entries.clear();
    this.bytes = 0;
    this.fingerprint = fingerprint;
  }

  /** A budget below what one view holds would evict and repaint on every frame; it grows to fit, with room to pan. */
  fit(viewBytes: number): void {
    this.budget = Math.max(this.budget, Math.ceil(viewBytes * 1.5));
  }

  get(key: string, paint: (canvas: HTMLCanvasElement) => void): HTMLCanvasElement {
    let canvas = this.entries.get(key);
    if (canvas) {
      this.entries.delete(key);
      this.entries.set(key, canvas);
      return canvas;
    }
    canvas = document.createElement('canvas');
    paint(canvas);
    const size = canvas.width * canvas.height * 4;
    while (this.bytes + size > this.budget && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value!;
      const dropped = this.entries.get(oldest)!;
      this.bytes -= dropped.width * dropped.height * 4;
      this.entries.delete(oldest);
    }
    this.entries.set(key, canvas);
    this.bytes += size;
    return canvas;
  }
}

/** The chunks a view touches, one chunk of margin on each side. */
function chunkRange(visible: Visible, cells: number): { cs0: number; cs1: number; ct0: number; ct1: number } {
  const a = cellOf({ x: visible.x0, y: visible.y0 });
  const b = cellOf({ x: visible.x1, y: visible.y0 });
  const c = cellOf({ x: visible.x0, y: visible.y1 });
  const d = cellOf({ x: visible.x1, y: visible.y1 });
  return {
    cs0: Math.floor(Math.min(a.s, b.s, c.s, d.s) / cells) - 1,
    cs1: Math.floor(Math.max(a.s, b.s, c.s, d.s) / cells) + 1,
    ct0: Math.floor(Math.min(a.t, b.t, c.t, d.t) / cells) - 1,
    ct1: Math.floor(Math.max(a.t, b.t, c.t, d.t) / cells) + 1,
  };
}

/** The chunks of a view that are on screen, with what they cost. */
function visibleChunks(
  visible: Visible,
  cells: number,
  box: (cs: number, ct: number, cells: number) => Visible,
  scale: number,
) {
  const { cs0, cs1, ct0, ct1 } = chunkRange(visible, cells);
  const shown: { cs: number; ct: number; box: Visible }[] = [];
  let bytes = 0;
  for (let cs = cs0; cs <= cs1; cs++) {
    for (let ct = ct0; ct <= ct1; ct++) {
      const b = box(cs, ct, cells);
      if (b.x1 < visible.x0 || b.x0 > visible.x1 || b.y1 < visible.y0 || b.y0 > visible.y1) continue;
      shown.push({ cs, ct, box: b });
      bytes += (b.x1 - b.x0) * scale * (b.y1 - b.y0) * scale * 4;
    }
  }
  return { shown, bytes };
}

function bucketFor(zoom: number): number {
  return ZOOM_BUCKETS.find((b) => b >= zoom) ?? ZOOM_BUCKETS[ZOOM_BUCKETS.length - 1];
}

function chunkBox(cs: number, ct: number, cells: number): Visible {
  const s0 = cs * cells;
  const t0 = ct * cells;
  const s1 = s0 + cells - 1;
  const t1 = t0 + cells - 1;
  return {
    x0: (s0 - t1) * TW - TW,
    x1: (s1 - t0) * TW + TW,
    y0: (s0 + t0) * TH - TH,
    y1: (s1 + t1) * TH + TH,
  };
}

/** Water outside any district, the kind that gets a sandy shore. */
function openWater(s: number, t: number, zones: readonly District[]): boolean {
  const cell = terrainCell(s, t, zones);
  return cell.ground === 'water' && !cell.zone;
}

function diamond(ctx: Ctx, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - TH);
  ctx.lineTo(x + TW, y);
  ctx.lineTo(x, y + TH);
  ctx.lineTo(x - TW, y);
  ctx.closePath();
}

/** The four edges of a cell, each with the neighbour across it. */
const EDGES: { ds: number; dt: number; a: (x: number, y: number) => Point; b: (x: number, y: number) => Point }[] = [
  { ds: -1, dt: 0, a: (x, y) => ({ x, y: y - TH }), b: (x, y) => ({ x: x - TW, y }) },
  { ds: 0, dt: -1, a: (x, y) => ({ x: x + TW, y }), b: (x, y) => ({ x, y: y - TH }) },
  { ds: 1, dt: 0, a: (x, y) => ({ x, y: y + TH }), b: (x, y) => ({ x: x + TW, y }) },
  { ds: 0, dt: 1, a: (x, y) => ({ x: x - TW, y }), b: (x, y) => ({ x, y: y + TH }) },
];

/**
 * Paints one chunk of ground into its own canvas, in world units at `scale`
 * pixels per unit. The land never changes on its own, so the chunk is drawn
 * once per zoom bucket and blitted from then on.
 */
function paintChunk(
  canvas: HTMLCanvasElement,
  cs: number,
  ct: number,
  scale: number,
  zones: readonly District[],
  dots: boolean,
  t: MapTokens,
): void {
  const cells = chunkCells(scale);
  const box = chunkBox(cs, ct, cells);
  canvas.width = Math.ceil((box.x1 - box.x0) * scale);
  canvas.height = Math.ceil((box.y1 - box.y0) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, -box.x0 * scale, -box.y0 * scale);

  const s0 = cs * cells;
  const t0 = ct * cells;
  // One cell of overlap: a diamond's corners reach into the neighbouring chunk's box.
  for (let s = s0 - 1; s <= s0 + cells; s++) {
    for (let u = t0 - 1; u <= t0 + cells; u++) {
      const cell = terrainCell(s, u, zones);
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      const colour = groundColour(cell, t.night, s, u);
      ctx.fillStyle = colour || t.water;
      diamond(ctx, x, y);
      ctx.fill();
      if (cell.ground === 'water' && !cell.zone && EDGES.every((e) => openWater(s + e.ds, u + e.dt, zones))) {
        ctx.fillStyle = 'rgba(10,30,60,0.14)';
        diamond(ctx, x, y);
        ctx.fill();
      }
      if (cell.zone) zoneMarks(ctx, cell, x, y, s, u);
      if (dots) groundDots(ctx, t, cell, x, y, s, u);
    }
  }
  // Shores after the ground, so the sand lies over both sides of the edge; a district's water has its own banks.
  ctx.fillStyle = t.night ? 'rgba(200,190,150,0.28)' : 'rgba(255,243,205,0.7)';
  for (let s = s0 - 1; s <= s0 + cells; s++) {
    for (let u = t0 - 1; u <= t0 + cells; u++) {
      if (!openWater(s, u, zones)) continue;
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      for (const e of EDGES) {
        if (openWater(s + e.ds, u + e.dt, zones)) continue;
        const a = e.a(x, y);
        const b = e.b(x, y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x + (x - b.x) * 0.3, b.y + (y - b.y) * 0.3);
        ctx.lineTo(a.x + (x - a.x) * 0.3, a.y + (y - a.y) * 0.3);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/**
 * From afar a tree is a dot, a mushroom a red one, a vent a dark speck: enough
 * for a forest or a district to keep its texture, cheap enough to bake into
 * the chunk. Cities and roads are painted over them.
 */
function groundDots(ctx: Ctx, t: MapTokens, cell: TerrainCell, x: number, y: number, s: number, u: number): void {
  const h = hash2(s, u);
  const dx = (hash2(s + 3, u) - 0.5) * TW * 0.9;
  const dy = (hash2(s, u + 3) - 0.5) * TH * 0.9;
  const dot = (colour: string, r: number, ox = dx, oy = dy) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x + ox, y + oy - r * 0.6, r, 0, Math.PI * 2);
    ctx.fill();
  };
  switch (cell.zone) {
    case undefined:
      if (cell.ground === 'forest' && h < 0.85) dot(t.night ? '#3b5a3c' : '#5f9a4c', 4.5 + h * 2);
      else if (cell.ground === 'rock' && h < 0.22) dot(t.night ? '#6c7270' : '#a7a9a1', 3);
      return;
    case 'blossom':
      if (h < 0.55) dot(h < 0.2 ? '#f7c3d8' : '#f3a9c9', 4.5 + h * 2);
      return;
    case 'volcanic':
      if (cell.ground === 'rock' && h < 0.1) dot('#3a3634', 4);
      return;
    case 'marsh':
      if (h < 0.5) dot('#5f7a4a', 2.5);
      return;
    case 'glacier':
      if (h < 0.12) dot('#e6f2f8', 3.5);
      return;
    case 'mushroom':
      if (h < 0.4) {
        dot(h < 0.15 ? '#6ea8d9' : '#d9534f', 3.5);
        dot('rgba(255,255,255,0.8)', 1.2, dx - 1, dy - 3);
      }
      return;
    case 'salt':
      return;
  }
}

/** What is painted into a district's ground itself: lava glow, ice cracks, salt cracks. */
function zoneMarks(ctx: Ctx, cell: TerrainCell, x: number, y: number, s: number, u: number): void {
  const h = hash2(s * 5, u * 3);
  if (cell.ground === 'lava') {
    ctx.fillStyle = 'rgba(255,230,140,0.55)';
    ctx.beginPath();
    ctx.ellipse(x + (h - 0.5) * 10, y + (hash2(u, s) - 0.5) * 5, 7, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (cell.ground === 'ice' && h < 0.25) {
    ctx.strokeStyle = 'rgba(150,190,210,0.7)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - 12 + h * 8, y - 2);
    ctx.lineTo(x - 2, y + 3 - h * 6);
    ctx.lineTo(x + 10, y - 1 + h * 4);
    ctx.stroke();
  } else if (cell.ground === 'salt' && h < 0.5) {
    ctx.strokeStyle = 'rgba(160,150,130,0.35)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - 14, y + 1 - h * 6);
    ctx.lineTo(x - 3, y + h * 5);
    ctx.lineTo(x + 6, y - 4 + h * 4);
    ctx.lineTo(x + 15, y + 2);
    ctx.stroke();
  }
}

/**
 * The ground, chunk by chunk, cached per zoom bucket. The cache is keyed on
 * the districts and the theme too: a district moving or changing its
 * landscape recolours the land under it.
 */
export class TerrainLayer {
  private cache = new ChunkCache(96 * 1024 * 1024);

  draw(ctx: Ctx, t: MapTokens, visible: Visible, zoom: number, zones: readonly District[]): void {
    this.cache.reset(
      [
        t.night ? 'n' : 'd',
        t.water,
        zones.map((d) => `${d.id},${d.x},${d.y},${d.w},${d.h},${d.terrain}`).join(';'),
      ].join('|'),
    );
    const scale = bucketFor(zoom);
    // Below the detail zoom the chunk carries the vegetation as dots; above it, the detail layer draws it.
    const dots = zoom < DETAIL_ZOOM;
    const { shown, bytes } = visibleChunks(visible, chunkCells(scale), chunkBox, scale);
    this.cache.fit(bytes);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (const { cs, ct, box } of shown) {
      const canvas = this.cache.get(`${scale}:${dots ? 'dots' : 'bare'}:${cs}:${ct}`, (c) =>
        paintChunk(c, cs, ct, scale, zones, dots, t),
      );
      ctx.drawImage(canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    }
    ctx.restore();
  }
}

/** Zoom from which single trees and stones are drawn; further out the biome colour stands for them. */
export const DETAIL_ZOOM = 0.75;
const FINE_ZOOM = 1.2;

/** A detail chunk reaches above its cells: a tree's crown stands well over the cell it grows on. */
const DETAIL_REACH = 40;

function detailBox(cs: number, ct: number, cells: number): Visible {
  const box = chunkBox(cs, ct, cells);
  return { x0: box.x0 - DETAIL_REACH, x1: box.x1 + DETAIL_REACH, y0: box.y0 - DETAIL_REACH, y1: box.y1 + TH };
}

function paintDetails(
  canvas: HTMLCanvasElement,
  cs: number,
  ct: number,
  scale: number,
  fine: boolean,
  zones: readonly District[],
  cities: readonly Point[],
  roadCells: ReadonlySet<string>,
  t: MapTokens,
): void {
  const cells = chunkCells(scale);
  const box = detailBox(cs, ct, cells);
  canvas.width = Math.ceil((box.x1 - box.x0) * scale);
  canvas.height = Math.ceil((box.y1 - box.y0) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, -box.x0 * scale, -box.y0 * scale);
  const s0 = cs * cells - 2;
  const s1 = cs * cells + cells + 1;
  const t0 = ct * cells - 2;
  const t1 = ct * cells + cells + 1;
  // Back to front, so a tree stands in front of the one behind it.
  for (let sum = s0 + t0; sum <= s1 + t1; sum++) {
    for (let s = s0; s <= s1; s++) {
      const u = sum - s;
      if (u < t0 || u > t1) continue;
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      const cell = terrainCell(s, u, zones);
      if (cell.ground === 'water') continue;
      if (roadCells.has(`${s},${u}`) || underCity({ x, y }, cities)) continue;
      const h = hash2(s, u);
      if (cell.zone) {
        zoneDetail(ctx, t, cell, x, y, s, u, h, fine, 0, false);
        continue;
      }
      const jitterX = (hash2(s + 3, u) - 0.5) * TW * 0.9;
      const jitterY = (hash2(s, u + 3) - 0.5) * TH * 0.9;
      if (cell.ground === 'forest') {
        if (h < 0.85) tree(ctx, t, x + jitterX, y + jitterY, 0.75 + h * 0.35);
        if (h < 0.3) tree(ctx, t, x - jitterX * 0.6, y + 3 - jitterY, 0.65);
      } else if (cell.ground === 'rock') {
        if (h < 0.22) stone(ctx, t, x + jitterX, y + jitterY, 0.7 + h * 2);
      } else if (fine && (cell.ground === 'meadow' || cell.ground === 'dry' || cell.ground === 'heath')) {
        if (h < 0.08) flowers(ctx, x + jitterX, y + jitterY, '#f2d36b');
        else if (h > 0.9) tuft(ctx, t, x + jitterX, y + jitterY, cell.ground === 'dry' ? '#a89f5e' : '#7ea86a');
      }
    }
  }
}

/**
 * What stands on the ground: trees on forest cells, stones on rock, tufts and
 * flowers close up, a district's own growth. Chunked and cached like the
 * ground, keyed on the cities and roads too, since trees keep clear of them;
 * a city being dragged repaints the chunks around it and nothing else.
 */
export class DetailLayer {
  private cache = new ChunkCache(64 * 1024 * 1024);

  draw(
    ctx: Ctx,
    t: MapTokens,
    visible: Visible,
    zoom: number,
    zones: readonly District[],
    cities: readonly Point[],
    roadCells: ReadonlySet<string>,
  ): void {
    if (zoom < DETAIL_ZOOM) return;
    const fine = zoom >= FINE_ZOOM;
    this.cache.reset(
      [
        t.night ? 'n' : 'd',
        zones.map((d) => `${d.id},${d.x},${d.y},${d.w},${d.h},${d.terrain}`).join(';'),
        cities.map((c) => `${c.x},${c.y}`).join(';'),
        [...roadCells].join(';'),
      ].join('|'),
    );
    const scale = bucketFor(zoom);
    const { shown, bytes } = visibleChunks(visible, chunkCells(scale), detailBox, scale);
    this.cache.fit(bytes);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (const { cs, ct, box } of shown) {
      const canvas = this.cache.get(`${scale}:${fine ? 'fine' : 'coarse'}:${cs}:${ct}`, (c) =>
        paintDetails(c, cs, ct, scale, fine, zones, cities, roadCells, t),
      );
      ctx.drawImage(canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    }
    ctx.restore();
  }
}

/** What stands in a district: blossom trees, vents, reeds, shards, mushrooms. */
function zoneDetail(
  ctx: Ctx,
  t: MapTokens,
  cell: TerrainCell,
  x: number,
  y: number,
  s: number,
  u: number,
  h: number,
  fine: boolean,
  time: number,
  animate: boolean,
): void {
  const jx = (hash2(s + 3, u) - 0.5) * TW * 0.9;
  const jy = (hash2(s, u + 3) - 0.5) * TH * 0.9;
  switch (cell.zone) {
    case 'blossom':
      if (h < 0.55) tree(ctx, t, x + jx, y + jy, 0.8 + h * 0.5, false, h < 0.2 ? '#f7c3d8' : '#f3a9c9');
      if (fine && h > 0.7) {
        ctx.fillStyle = 'rgba(245,170,200,0.8)';
        for (const [dx, dy] of [
          [-6, 2],
          [3, -1],
          [8, 3],
        ]) {
          ctx.fillRect(x + dx + jx, y + dy, 1.5, 1.5);
        }
      }
      break;
    case 'volcanic':
      if (cell.ground === 'rock' && h < 0.1) vent(ctx, x + jx, y + jy, time, animate, h);
      else if (cell.ground === 'rock' && h > 0.85) stone(ctx, t, x + jx, y + jy, 0.6 + h * 0.5);
      break;
    case 'marsh':
      if (h < 0.5) reeds(ctx, x + jx, y + jy, h);
      break;
    case 'glacier':
      if (h < 0.12) shard(ctx, x + jx, y + jy, 0.8 + h * 3);
      else if (fine && h > 0.92) tuft(ctx, t, x + jx, y + jy, '#e8f2f6');
      break;
    case 'mushroom':
      if (h < 0.4) mushroom(ctx, t, x + jx, y + jy, 0.7 + h, h < 0.15);
      break;
    case 'salt':
      break;
  }
}

function vent(ctx: Ctx, x: number, y: number, time: number, animate: boolean, seed: number): void {
  ctx.fillStyle = '#3a3634';
  ctx.beginPath();
  ctx.moveTo(x - 8, y);
  ctx.lineTo(x - 2, y - 9);
  ctx.lineTo(x + 2, y - 9);
  ctx.lineTo(x + 8, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ff8a3a';
  ctx.fillRect(x - 2, y - 10, 4, 1.5);
  for (let k = 0; k < 3; k++) {
    const phase = animate ? (time / 2400 + seed * 9 + k / 3) % 1 : (k + 0.5) / 3;
    ctx.fillStyle = `rgba(120,115,110,${(0.35 * (1 - phase)).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x + Math.sin(phase * 6 + k) * 3, y - 12 - phase * 26, 3 + phase * 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function reeds(ctx: Ctx, x: number, y: number, seed: number): void {
  ctx.strokeStyle = '#5f7a4a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const dx of [-5, -2, 1, 4]) {
    ctx.moveTo(x + dx, y);
    ctx.lineTo(x + dx + seed * 2, y - 9 - Math.abs(dx));
  }
  ctx.stroke();
  ctx.fillStyle = '#6b4a2e';
  ctx.fillRect(x + 1 + seed * 2 - 0.8, y - 13, 1.6, 4);
  ctx.fillRect(x - 5 + seed * 2 - 0.8, y - 15, 1.6, 4);
}

function shard(ctx: Ctx, x: number, y: number, scale: number): void {
  ctx.fillStyle = 'rgba(31,42,60,0.15)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 6 * scale, 2.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#bcd8e6';
  ctx.beginPath();
  ctx.moveTo(x - 5 * scale, y);
  ctx.lineTo(x - 1 * scale, y - 12 * scale);
  ctx.lineTo(x + 4 * scale, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e6f2f8';
  ctx.beginPath();
  ctx.moveTo(x - 5 * scale, y);
  ctx.lineTo(x - 1 * scale, y - 12 * scale);
  ctx.lineTo(x - 0.5 * scale, y);
  ctx.closePath();
  ctx.fill();
}

function mushroom(ctx: Ctx, t: MapTokens, x: number, y: number, scale: number, blue: boolean): void {
  ctx.fillStyle = 'rgba(31,42,34,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 5 * scale, 2 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(x - 1.5 * scale, y - 9 * scale, 3 * scale, 9 * scale);
  ctx.fillStyle = blue ? (t.lit ? '#8fd0f0' : '#6ea8d9') : '#d9534f';
  ctx.beginPath();
  ctx.ellipse(x, y - 9 * scale, 7 * scale, 4.5 * scale, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const [dx, dy] of [
    [-3, -1.5],
    [1, -3],
    [3.5, -1],
  ]) {
    ctx.beginPath();
    ctx.arc(x + dx * scale, y - 9 * scale + dy * scale, 0.9 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

function stone(ctx: Ctx, t: MapTokens, x: number, y: number, scale: number): void {
  ctx.fillStyle = 'rgba(31,42,34,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 6 * scale, 2.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.night ? '#6c7270' : '#a7a9a1';
  ctx.beginPath();
  ctx.moveTo(x - 5 * scale, y);
  ctx.lineTo(x - 2 * scale, y - 5 * scale);
  ctx.lineTo(x + 3 * scale, y - 4 * scale);
  ctx.lineTo(x + 5 * scale, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = t.night ? '#85897f' : '#c5c7bf';
  ctx.beginPath();
  ctx.moveTo(x - 5 * scale, y);
  ctx.lineTo(x - 2 * scale, y - 5 * scale);
  ctx.lineTo(x, y - 1.5 * scale);
  ctx.closePath();
  ctx.fill();
}

function flowers(ctx: Ctx, x: number, y: number, colour: string): void {
  ctx.fillStyle = colour;
  for (const [dx, dy] of [
    [-4, 0],
    [1, -2],
    [4, 1],
  ]) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tuft(ctx: Ctx, t: MapTokens, x: number, y: number, colour: string): void {
  ctx.strokeStyle = t.night ? 'rgba(120,140,110,0.7)' : colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const dx of [-3, -1, 1, 3]) {
    ctx.moveTo(x + dx, y);
    ctx.lineTo(x + dx * 1.6, y - 4 - Math.abs(dx) * 0.4);
  }
  ctx.stroke();
}
