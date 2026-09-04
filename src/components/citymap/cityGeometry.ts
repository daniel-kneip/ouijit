import type { TerminalDisplayState } from '../../stores/terminalDisplay';
import type { TaskStatus } from '../../types';

/** Half extents of one isometric cell, in map units. */
export const TW = 22;
export const TH = 11;
/** Cells per city side; the middle row and column are roads. */
export const N = 7;
export const STOREY = 13;
export const CITY_HALF_W = N * TW;
export const CITY_HALF_H = N * TH;

export const WALLS = ['#f2e3c1', '#e8a07a', '#8ec9c2', '#93b5e0', '#c1a3d9', '#eacc6b', '#f0b4a8', '#b9d98b'];

export type CityCell =
  | { i: number; j: number; type: 'road' }
  | { i: number; j: number; type: 'building'; storeys: number; wall: string }
  | { i: number; j: number; type: 'park'; trees: number }
  | { i: number; j: number; type: 'lot' };

export interface CitySlot {
  i: number;
  j: number;
  wall: string;
  storeys: number;
}

export interface CityLayout {
  cells: CityCell[];
  /** Where construction sites go, in the order they are handed out. */
  slots: CitySlot[];
}

export interface Point {
  x: number;
  y: number;
}

export type SiteState = 'working' | 'waiting' | 'error' | 'done' | 'exited';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const layoutCache = new Map<number, CityLayout>();

/** The same task number always lays out the same city. */
export function cityLayout(taskNumber: number): CityLayout {
  const cached = layoutCache.get(taskNumber);
  if (cached) return cached;

  const rnd = mulberry32(taskNumber * 7919 + 13);
  const cells: CityCell[] = [];
  const lots: CityCell[] = [];
  const others: CityCell[] = [];
  const mid = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let cell: CityCell;
      if (i === mid || j === mid) cell = { i, j, type: 'road' };
      else {
        const r = rnd();
        if (r < 0.55) {
          cell = { i, j, type: 'building', storeys: 1 + Math.floor(rnd() * 4), wall: WALLS[Math.floor(rnd() * 8)] };
        } else if (r < 0.75) cell = { i, j, type: 'park', trees: 1 + Math.floor(rnd() * 2) };
        else cell = { i, j, type: 'lot' };
      }
      cells.push(cell);
      if (cell.type === 'lot') lots.push(cell);
      else if (cell.type !== 'road') others.push(cell);
    }
  }
  const shuffle = <T>(arr: T[]): T[] => {
    for (let k = arr.length - 1; k > 0; k--) {
      const m = Math.floor(rnd() * (k + 1));
      [arr[k], arr[m]] = [arr[m], arr[k]];
    }
    return arr;
  };
  const slots = [...shuffle(lots), ...shuffle(others)].map((c) => ({
    i: c.i,
    j: c.j,
    wall: WALLS[Math.floor(rnd() * 8)],
    storeys: 1 + Math.floor(rnd() * 2),
  }));
  const layout = { cells, slots };
  layoutCache.set(taskNumber, layout);
  return layout;
}

export function cellCenter(i: number, j: number): Point {
  return { x: (i - j) * TW, y: (i + j) * TH - (N - 1) * TH };
}

/**
 * A spot for a new city: along a sunflower spiral from the map centre, the
 * first one at least a city's width from every existing city.
 */
export function freePosition(existing: Point[]): Point {
  for (let k = 0; k < 600; k++) {
    const r = 430 * Math.sqrt(k);
    const a = k * 2.39996;
    const p = { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a) * 0.72) };
    if (existing.every((c) => Math.hypot(c.x - p.x, (c.y - p.y) * 1.4) >= 470)) return p;
  }
  return { x: 0, y: 0 };
}

/** The lowest slot no site or finished building holds. */
export function nextFreeSlot(taken: Iterable<number>, slotCount: number): number | null {
  const used = new Set(taken);
  for (let slot = 0; slot < slotCount; slot++) if (!used.has(slot)) return slot;
  return null;
}

export function siteState(display: Pick<TerminalDisplayState, 'summaryType' | 'hookStatus' | 'exited'>): SiteState {
  if (display.exited) return 'exited';
  if (display.summaryType === 'thinking' || display.hookStatus === 'thinking') return 'working';
  if (display.summaryType === 'error') return 'error';
  if (display.summaryType === 'success') return 'done';
  return 'waiting';
}

export const SITE_STATE_LABEL: Record<SiteState, string> = {
  working: 'Agent working',
  waiting: 'Waiting for you',
  error: 'Problem',
  done: 'Finished',
  exited: 'Exited',
};

export type CityPresence = 'blueprint' | 'building' | 'review' | 'settled';

export function cityPresence(status: TaskStatus): CityPresence {
  switch (status) {
    case 'todo':
      return 'blueprint';
    case 'in_progress':
      return 'building';
    case 'in_review':
      return 'review';
    case 'done':
      return 'settled';
  }
}

/** The nearest point on the lattice one cell step apart along both iso axes. */
export function snapToCells(p: Point): Point {
  const s = Math.round((p.x / TW + p.y / TH) / 2);
  const t = Math.round((p.y / TH - p.x / TW) / 2);
  return { x: (s - t) * TW, y: (s + t) * TH };
}

export function pointInCity(local: Point): boolean {
  return Math.abs(local.x) / CITY_HALF_W + Math.abs(local.y) / CITY_HALF_H <= 1.05;
}
