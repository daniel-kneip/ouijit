import { CITY_HALF_H, CITY_HALF_W, N, TH, TW, hash2, type Point } from './cityGeometry';
import { pointInDistrict, type District, type DistrictTerrain } from '../../stores/cityMapStore';

/**
 * The land under the cities, cell by cell on the same lattice the cities snap
 * to. Everything here is a pure function of the cell, so the ground, the water
 * a road has to bridge and the trees a city sits among all agree without a
 * stored map. Cell (s, t) is at world ((s − t)·TW, (s + t)·TH).
 */

export type Ground =
  | 'water'
  | 'meadow'
  | 'dry'
  | 'forest'
  | 'heath'
  | 'rock'
  | 'lava'
  | 'ice'
  | 'marsh'
  | 'moss'
  | 'salt'
  | 'brine';

export interface Cell {
  s: number;
  t: number;
}

export interface TerrainCell {
  ground: Ground;
  /** 0 to 1, low ground first. */
  elevation: number;
  /** The district the cell lies in, whose landscape replaces the land's own. */
  zone?: DistrictTerrain;
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

/** What a district's landscape makes of a cell, water or land. */
function zoneGround(zone: DistrictTerrain, s: number, t: number, water: boolean): Ground {
  const n = noise(s / 3, t / 3, 8);
  switch (zone) {
    case 'blossom':
      return water ? 'water' : 'meadow';
    case 'volcanic':
      return water ? 'water' : n > 0.72 ? 'lava' : 'rock';
    case 'marsh':
      return water || n > 0.6 ? 'water' : 'marsh';
    case 'glacier':
      return 'ice';
    case 'mushroom':
      return water ? 'water' : 'moss';
    case 'salt':
      return water ? 'brine' : 'salt';
  }
}

const cellMemo = new Map<number, TerrainCell>();
let memoZones = '';
let keyedZones: readonly District[] | null = null;
let keyedZonesKey = '';
const MEMO_CAP = 400_000;

/** The districts' key, rebuilt only when a different array comes in: the store hands out the same one until it changes. */
function zonesKey(zones: readonly District[]): string {
  if (zones !== keyedZones) {
    keyedZones = zones;
    keyedZonesKey = zones.map((d) => `${d.id},${d.x},${d.y},${d.w},${d.h},${d.terrain}`).join(';');
  }
  return keyedZonesKey;
}

/**
 * A cell costs a dozen noise samples and is asked for by the ground, the
 * trees, the shores and the bridges alike, so it is worked out once and kept
 * until the districts change.
 */
export function terrainCell(s: number, t: number, zones: readonly District[] = []): TerrainCell {
  const key = zonesKey(zones);
  if (key !== memoZones) {
    cellMemo.clear();
    memoZones = key;
  }
  const id = (s + 50_000) * 100_000 + (t + 50_000);
  const known = cellMemo.get(id);
  if (known) return known;
  const cell = computeCell(s, t, zones);
  if (cellMemo.size >= MEMO_CAP) cellMemo.clear();
  cellMemo.set(id, cell);
  return cell;
}

function computeCell(s: number, t: number, zones: readonly District[]): TerrainCell {
  const e = elevation(s, t);
  const water = isWater(s, t);
  const zone = zones.find((d) => pointInDistrict(d, latticePoint(s, t)))?.terrain;
  if (zone) return { ground: zoneGround(zone, s, t, water), elevation: e, zone };
  if (water) return { ground: 'water', elevation: e };
  const m = moisture(s, t);
  let ground: Ground;
  if (e > 0.84) ground = 'rock';
  else if (e > 0.74) ground = 'heath';
  else if (m > 0.62) ground = 'forest';
  else if (m < 0.35) ground = 'dry';
  else ground = 'meadow';
  return { ground, elevation: e };
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

type LandGround = 'meadow' | 'dry' | 'forest' | 'heath' | 'rock';

/** Close shades of one green: the land is a background, and reads as one piece from afar. */
const PALETTE: Record<LandGround, string> = {
  meadow: '#b8cf9c',
  dry: '#c2cd97',
  forest: '#a6c48f',
  heath: '#b3c297',
  rock: '#b8bfa8',
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

/** Two tones per district ground, picked cell by cell, and the district's own water. */
const ZONE_PALETTE: Record<DistrictTerrain, { ground: [string, string]; water: string }> = {
  blossom: { ground: ['#d3e2b3', '#dce8bf'], water: '#9cc6de' },
  volcanic: { ground: ['#5b5653', '#666059'], water: '#3d4a55' },
  marsh: { ground: ['#7c9468', '#88a074'], water: '#6f8f89' },
  glacier: { ground: ['#dbe9f0', '#cfe2ec'], water: '#cfe2ec' },
  mushroom: { ground: ['#6f8a6a', '#7b9473'], water: '#5f8a86' },
  salt: { ground: ['#f1eee4', '#e8e4d8'], water: '#e3c6cf' },
};

const LAVA = ['#ff7f2f', '#ffa042'];

function shade(hex: string, night: boolean): string {
  const { h, s, l } = hexToHsl(hex);
  const lightness = Math.max(0, Math.min(100, l * 100 - (night ? 22 : 0)));
  const saturation = Math.max(0, s * 100 - (night ? 12 : 0));
  return `hsl(${Math.round(h * 360)},${saturation.toFixed(0)}%,${lightness.toFixed(0)}%)`;
}

/**
 * The ground's colour, darkened at night. Empty for open water, which takes
 * the theme's colour; a district's water is the district's own.
 */
export function groundColour(cell: TerrainCell, night: boolean, s = 0, t = 0): string {
  if (cell.zone) {
    const zone = ZONE_PALETTE[cell.zone];
    if (cell.ground === 'water' || cell.ground === 'brine') return shade(zone.water, night);
    const tone = noise(s / 2.5, t / 2.5, 9) > 0.5 ? 1 : 0;
    if (cell.ground === 'lava') return LAVA[tone];
    return shade(zone.ground[tone], night);
  }
  if (cell.ground === 'water') return '';
  return shade(PALETTE[cell.ground as LandGround], night);
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
