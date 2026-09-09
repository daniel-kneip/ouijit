import type { District } from '../../stores/cityMapStore';
import { TH, TW, hash2, type Point } from './cityGeometry';
import { plant, tree, type MapTokens } from './drawCity';
import { cellOf, groundColour, isWater, terrainCell, underCity, type Climate, type TerrainCell } from './terrain';

type Ctx = CanvasRenderingContext2D;

interface Visible {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Cells per chunk side, in lattice coordinates. */
const CHUNK = 16;
const CACHE_CAP = 240;
const ZOOM_BUCKETS = [0.5, 1, 2];

function chunkBox(cs: number, ct: number): Visible {
  const s0 = cs * CHUNK;
  const t0 = ct * CHUNK;
  const s1 = s0 + CHUNK - 1;
  const t1 = t0 + CHUNK - 1;
  return {
    x0: (s0 - t1) * TW - TW,
    x1: (s1 - t0) * TW + TW,
    y0: (s0 + t0) * TH - TH,
    y1: (s1 + t1) * TH + TH,
  };
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
  climates: readonly Climate[],
  zones: readonly District[],
  t: MapTokens,
): void {
  const box = chunkBox(cs, ct);
  canvas.width = Math.ceil((box.x1 - box.x0) * scale);
  canvas.height = Math.ceil((box.y1 - box.y0) * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, -box.x0 * scale, -box.y0 * scale);

  const s0 = cs * CHUNK;
  const t0 = ct * CHUNK;
  // One cell of overlap: a diamond's corners reach into the neighbouring chunk's box.
  for (let s = s0 - 1; s <= s0 + CHUNK; s++) {
    for (let u = t0 - 1; u <= t0 + CHUNK; u++) {
      const cell = terrainCell(s, u, climates, zones);
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      const colour = groundColour(cell, t.night, s, u);
      ctx.fillStyle = colour || t.water;
      diamond(ctx, x, y);
      ctx.fill();
      if (cell.ground === 'water' && !cell.zone && EDGES.every((e) => isWater(s + e.ds, u + e.dt))) {
        ctx.fillStyle = 'rgba(10,30,60,0.14)';
        diamond(ctx, x, y);
        ctx.fill();
      }
      if (cell.zone) zoneMarks(ctx, cell, x, y, s, u);
    }
  }
  // Shores after the ground, so the sand lies over both sides of the edge; a district's water has its own banks.
  ctx.fillStyle = t.night ? 'rgba(200,190,150,0.28)' : 'rgba(255,243,205,0.7)';
  for (let s = s0 - 1; s <= s0 + CHUNK; s++) {
    for (let u = t0 - 1; u <= t0 + CHUNK; u++) {
      if (!isWater(s, u) || terrainCell(s, u, climates, zones).zone) continue;
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      for (const e of EDGES) {
        if (isWater(s + e.ds, u + e.dt)) continue;
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
 * the climates and the theme too: a city moving or changing its biome
 * recolours the land around it.
 */
export class TerrainLayer {
  private cache = new Map<string, HTMLCanvasElement>();
  private fingerprint = '';

  draw(
    ctx: Ctx,
    t: MapTokens,
    visible: Visible,
    zoom: number,
    climates: readonly Climate[],
    zones: readonly District[],
  ): void {
    const fingerprint = [
      t.night ? 'n' : 'd',
      t.water,
      climates.map((c) => `${c.s},${c.t},${c.biome}`).join(';'),
      zones.map((d) => `${d.id},${d.x},${d.y},${d.w},${d.h},${d.terrain}`).join(';'),
    ].join('|');
    if (fingerprint !== this.fingerprint) {
      this.cache.clear();
      this.fingerprint = fingerprint;
    }
    const scale = ZOOM_BUCKETS.find((b) => b >= zoom) ?? ZOOM_BUCKETS[ZOOM_BUCKETS.length - 1];
    const a = cellOf({ x: visible.x0, y: visible.y0 });
    const b = cellOf({ x: visible.x1, y: visible.y0 });
    const c = cellOf({ x: visible.x0, y: visible.y1 });
    const d = cellOf({ x: visible.x1, y: visible.y1 });
    const cs0 = Math.floor(Math.min(a.s, b.s, c.s, d.s) / CHUNK) - 1;
    const cs1 = Math.floor(Math.max(a.s, b.s, c.s, d.s) / CHUNK) + 1;
    const ct0 = Math.floor(Math.min(a.t, b.t, c.t, d.t) / CHUNK) - 1;
    const ct1 = Math.floor(Math.max(a.t, b.t, c.t, d.t) / CHUNK) + 1;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    for (let cs = cs0; cs <= cs1; cs++) {
      for (let ct = ct0; ct <= ct1; ct++) {
        const box = chunkBox(cs, ct);
        if (box.x1 < visible.x0 || box.x0 > visible.x1 || box.y1 < visible.y0 || box.y0 > visible.y1) continue;
        const key = `${scale}:${cs}:${ct}`;
        let canvas = this.cache.get(key);
        if (!canvas) {
          canvas = document.createElement('canvas');
          paintChunk(canvas, cs, ct, scale, climates, zones, t);
          if (this.cache.size >= CACHE_CAP) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, canvas);
        } else {
          // Re-insert so the least recently used is what the cap drops.
          this.cache.delete(key);
          this.cache.set(key, canvas);
        }
        ctx.drawImage(canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      }
    }
    ctx.restore();
  }
}

/** Zoom from which single trees and stones are drawn; further out the biome colour stands for them. */
export const DETAIL_ZOOM = 0.75;
const FINE_ZOOM = 1.2;

/**
 * What stands on the ground: trees on forest cells, stones on rock, tufts and
 * flowers close up, a glint on the water. Drawn live, since trees keep clear
 * of cities and roads, which move.
 */
export function drawTerrainDetails(
  ctx: Ctx,
  t: MapTokens,
  visible: Visible,
  zoom: number,
  climates: readonly Climate[],
  zones: readonly District[],
  cities: readonly Point[],
  roadCells: ReadonlySet<string>,
  time: number,
  animate: boolean,
): void {
  if (zoom < DETAIL_ZOOM) return;
  const fine = zoom >= FINE_ZOOM;
  const a = cellOf({ x: visible.x0, y: visible.y0 });
  const b = cellOf({ x: visible.x1, y: visible.y0 });
  const c = cellOf({ x: visible.x0, y: visible.y1 });
  const d = cellOf({ x: visible.x1, y: visible.y1 });
  const s0 = Math.min(a.s, b.s, c.s, d.s) - 1;
  const s1 = Math.max(a.s, b.s, c.s, d.s) + 1;
  const t0 = Math.min(a.t, b.t, c.t, d.t) - 1;
  const t1 = Math.max(a.t, b.t, c.t, d.t) + 1;
  // Back to front, so a tree stands in front of the one behind it.
  for (let sum = s0 + t0; sum <= s1 + t1; sum++) {
    for (let s = s0; s <= s1; s++) {
      const u = sum - s;
      if (u < t0 || u > t1) continue;
      const x = (s - u) * TW;
      const y = (s + u) * TH;
      if (x < visible.x0 - 40 || x > visible.x1 + 40 || y < visible.y0 - 40 || y > visible.y1 + 20) continue;
      const cell = terrainCell(s, u, climates, zones);
      const h = hash2(s, u);
      if (cell.zone) {
        if (cell.ground !== 'water' && !roadCells.has(`${s},${u}`) && !underCity({ x, y }, cities)) {
          zoneDetail(ctx, t, cell, x, y, s, u, h, fine, time, animate);
        }
        continue;
      }
      if (cell.ground === 'water') {
        if (animate && zoom >= 0.9 && h > 0.6) {
          const twinkle = Math.sin(time / 900 + h * 40) > 0.94;
          if (twinkle) {
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillRect(x + (h - 0.5) * 20, y + (hash2(u, s) - 0.5) * 8, 2, 1.2);
          }
        }
        continue;
      }
      if (roadCells.has(`${s},${u}`) || underCity({ x, y }, cities)) continue;
      const jitterX = (hash2(s + 3, u) - 0.5) * TW * 0.9;
      const jitterY = (hash2(s, u + 3) - 0.5) * TH * 0.9;
      if (cell.ground === 'forest') {
        if (h < 0.85) plant(ctx, t, cell.biome, 'summer', x + jitterX, y + jitterY, 0.75 + h * 0.35, false);
        if (h < 0.3) plant(ctx, t, cell.biome, 'summer', x - jitterX * 0.6, y + 3 - jitterY, 0.65, false);
      } else if (cell.ground === 'rock') {
        if (h < 0.22) stone(ctx, t, x + jitterX, y + jitterY, 0.7 + h * 2);
      } else if (fine && (cell.ground === 'meadow' || cell.ground === 'dry' || cell.ground === 'heath')) {
        if (h < 0.08) flowers(ctx, x + jitterX, y + jitterY, cell.biome === 'tundra' ? '#e7e2f4' : '#f2d36b');
        else if (h > 0.9) tuft(ctx, t, x + jitterX, y + jitterY, cell.ground === 'dry' ? '#a89f5e' : '#7ea86a');
      }
    }
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
