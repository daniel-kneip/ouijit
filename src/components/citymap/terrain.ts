import { CITY_HALF_H, CITY_HALF_W, N, TH, TW, hash2, type Biome, type Point } from './cityGeometry';

/**
 * The land under the cities, cell by cell on the same lattice the cities snap
 * to. Everything here is a pure function of the cell, so the ground, the water
 * a road has to bridge and the trees a city sits among all agree without a
 * stored map. Cell (s, t) is at world ((s − t)·TW, (s + t)·TH).
 */

export type Ground = 'water' | 'meadow' | 'dry' | 'forest' | 'heath' | 'rock' | 'sand';

export interface Cell {
  s: number;
  t: number;
}

export interface TerrainCell {
  ground: Ground;
  /** 0 to 1, low ground first. */
  elevation: number;
  /** −1 to 1: the slope faces the light (positive) or away from it. */
  slope: number;
  /** The nearest city's climate, if one is close; the land takes its colours. */
  biome: Biome;
}

/** A city's climate as it reaches the land around it. */
export interface Climate extends Cell {
  biome: Biome;
}

export function cellOf(p: Point): Cell {
  return { s: Math.round((p.x / TW + p.y / TH) / 2), t: Math.round((p.y / TH - p.x / TW) / 2) };
}

export function latticePoint(s: number, t: number): Point {
  return { x: (s - t) * TW, y: (s + t) * TH };
}

function smooth(a: number): number {
  return a * a * (3 - 2 * a);
}

/** Value noise over the lattice, in [0, 1). */
export function noise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const h = (i: number, j: number) => hash2(i * 3 + seed * 1013, j * 7 - seed * 517);
  const top = h(x0, y0) * (1 - fx) + h(x0 + 1, y0) * fx;
  const bottom = h(x0, y0 + 1) * (1 - fx) + h(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

export function elevation(s: number, t: number): number {
  return 0.55 * noise(s / 22, t / 22, 1) + 0.3 * noise(s / 8, t / 8, 2) + 0.15 * noise(s / 3, t / 3, 3);
}

/** Where the river runs: its centre line as a t for every s, winding along the s axis. */
export function riverCentre(s: number): number {
  return 34 + 26 * Math.sin(s / 41) + 12 * Math.sin(s / 17 + 2) + 20 * (noise(s / 9, 0, 6) - 0.5);
}

const RIVER_HALF_WIDTH = 1.3;

function moisture(s: number, t: number): number {
  const base = 0.6 * noise(s / 16, t / 16, 4) + 0.4 * noise(s / 6, t / 6, 5);
  const fromRiver = Math.max(0, 1 - Math.abs(t - riverCentre(s)) / 6);
  return base + 0.3 * fromRiver;
}

export function isWater(s: number, t: number): boolean {
  if (Math.abs(t - riverCentre(s)) < RIVER_HALF_WIDTH) return true;
  return elevation(s, t) < 0.34 && moisture(s, t) > 0.58;
}

const CLIMATE_REACH = 9;

/** A city's climate reaches a few cells out, with an edge that wanders rather than a ruled one. */
function climateAt(s: number, t: number, climates: readonly Climate[]): Biome {
  let best: Climate | undefined;
  let bestDistance = Infinity;
  for (const c of climates) {
    const d = Math.max(Math.abs(c.s - s), Math.abs(c.t - t)) + Math.min(Math.abs(c.s - s), Math.abs(c.t - t)) * 0.5;
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  if (!best) return 'meadow';
  const reach = CLIMATE_REACH * (0.7 + 0.7 * noise(s / 4, t / 4, 7));
  return bestDistance <= reach ? best.biome : 'meadow';
}

export function terrainCell(s: number, t: number, climates: readonly Climate[] = []): TerrainCell {
  const e = elevation(s, t);
  const biome = climateAt(s, t, climates);
  const slope = Math.max(-1, Math.min(1, (elevation(s - 1, t - 1) - elevation(s + 1, t + 1)) * 6));
  if (isWater(s, t)) return { ground: 'water', elevation: e, slope, biome };
  const m = moisture(s, t);
  let ground: Ground;
  if (e > 0.84) ground = 'rock';
  else if (e > 0.74) ground = 'heath';
  else if (m > 0.62) ground = 'forest';
  else if (m < 0.35) ground = 'dry';
  else ground = 'meadow';
  if (biome === 'desert' && ground !== 'rock') ground = ground === 'forest' ? 'dry' : 'sand';
  return { ground, elevation: e, slope, biome };
}

/** The lattice cells a city's ground covers: N×N around its centre cell. */
export function cityCells(pos: Point): { s0: number; s1: number; t0: number; t1: number } {
  const c = cellOf(pos);
  const half = (N - 1) / 2;
  return { s0: c.s - half, s1: c.s + half, t0: c.t - half, t1: c.t + half };
}

/** Whether a world point lies under some city's ground, with a cell's margin around it. */
export function underCity(p: Point, cities: readonly Point[]): boolean {
  return cities.some((c) => Math.abs(c.x - p.x) < CITY_HALF_W + TW && Math.abs(c.y - p.y) < CITY_HALF_H + TH);
}

const ROAD_CLEARANCE = (N - 1) / 2 + 1;

/**
 * A road between two cities, along the lattice: out of the first city's edge,
 * along the axis the other city is mostly in, one bend, in at the other's
 * edge. Empty when the cities overlap. Points are cell centres, so a road runs
 * where the ground grid does and turns where the cells turn.
 */
export function roadRoute(from: Point, to: Point): Point[] {
  const a = cellOf(from);
  const b = cellOf(to);
  const ds = b.s - a.s;
  const dt = b.t - a.t;
  const clear = ROAD_CLEARANCE;
  if (Math.abs(ds) < clear && Math.abs(dt) < clear) return [];
  const sign = (n: number) => (n < 0 ? -1 : 1);
  const cells: Cell[] = [];
  if (Math.abs(ds) >= Math.abs(dt)) {
    const start = { s: a.s + sign(ds) * clear, t: a.t };
    if (Math.abs(dt) < clear) {
      cells.push(start, { s: b.s - sign(ds) * clear, t: a.t });
    } else {
      cells.push(start, { s: b.s, t: a.t }, { s: b.s, t: b.t - sign(dt) * clear });
    }
  } else {
    const start = { s: a.s, t: a.t + sign(dt) * clear };
    if (Math.abs(ds) < clear) {
      cells.push(start, { s: a.s, t: b.t - sign(dt) * clear });
    } else {
      cells.push(start, { s: a.s, t: b.t }, { s: b.s - sign(ds) * clear, t: b.t });
    }
  }
  return cells.map((c) => latticePoint(c.s, c.t));
}

/** Every cell a route passes, in order, legs being axis-aligned. */
export function routeCells(route: readonly Point[]): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < route.length; i++) {
    const here = cellOf(route[i]);
    if (i === 0) {
      cells.push(here);
      continue;
    }
    const prev = cellOf(route[i - 1]);
    const steps = Math.max(Math.abs(here.s - prev.s), Math.abs(here.t - prev.t));
    const ds = Math.sign(here.s - prev.s);
    const dt = Math.sign(here.t - prev.t);
    for (let k = 1; k <= steps; k++) cells.push({ s: prev.s + ds * k, t: prev.t + dt * k });
  }
  return cells;
}

export function cellKey(c: Cell): string {
  return `${c.s},${c.t}`;
}

const PALETTE: Record<Biome, Record<Exclude<Ground, 'water'>, string>> = {
  meadow: { meadow: '#b8cf9c', dry: '#c9c58a', forest: '#8fb37e', heath: '#a9b08a', rock: '#b3b6a6', sand: '#d9cfa0' },
  forest: { meadow: '#9fbf86', dry: '#b3b57a', forest: '#7aa46b', heath: '#95a37c', rock: '#aeb0a5', sand: '#cbc498' },
  desert: { meadow: '#d8cc96', dry: '#e5d3a1', forest: '#c4b97c', heath: '#d2bd86', rock: '#c9b593', sand: '#ecdcaa' },
  tundra: { meadow: '#c6d3c4', dry: '#cfd3c2', forest: '#b3c7ad', heath: '#c9cfc8', rock: '#d6dadb', sand: '#dcdcd2' },
  tropical: {
    meadow: '#c4d996',
    dry: '#d3d39a',
    forest: '#9ecb74',
    heath: '#b7c98a',
    rock: '#b9b9a4',
    sand: '#e6dcae',
  },
};

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

/** The ground's colour, shifted by lightness points and, at night, darkened. */
export function groundColour(cell: TerrainCell, night: boolean): string {
  if (cell.ground === 'water') return '';
  const { h, s, l } = hexToHsl(PALETTE[cell.biome][cell.ground]);
  const relief = (cell.elevation - 0.5) * 12 + cell.slope * 5;
  const lightness = Math.max(0, Math.min(100, l * 100 + relief - (night ? 22 : 0)));
  const saturation = Math.max(0, s * 100 - (night ? 12 : 0));
  return `hsl(${Math.round(h * 360)},${saturation.toFixed(0)}%,${lightness.toFixed(0)}%)`;
}

/**
 * How the light of the day tints the map: cool before eight, warm after five,
 * blue and dim through the night. Nothing in the middle of the day. In a dark
 * theme it is night already, so only the hour's warmth is added.
 */
export function daylightTint(date: Date, night: boolean): { colour: string; op: GlobalCompositeOperation } | null {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 17 && hour < 20)
    return { colour: `rgba(255,165,80,${(0.06 + (hour - 17) * 0.03).toFixed(3)})`, op: 'multiply' };
  if (night) return null;
  if (hour >= 20 || hour < 5) return { colour: 'rgba(40,55,95,0.26)', op: 'multiply' };
  if (hour >= 5 && hour < 8)
    return { colour: `rgba(190,170,220,${(0.16 - (hour - 5) * 0.05).toFixed(3)})`, op: 'multiply' };
  return null;
}

/** Windows are lit from dusk to morning, and whenever the theme is night. */
export function windowsLit(date: Date, night: boolean): boolean {
  const hour = date.getHours();
  return night || hour >= 18 || hour < 7;
}
