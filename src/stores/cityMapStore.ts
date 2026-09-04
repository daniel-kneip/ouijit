import { create } from 'zustand';
import { cityLayout, freePosition, nextFreeSlot, type Point } from '../components/citymap/cityGeometry';
import type { TerminalDisplayState } from './terminalDisplay';

export interface CityPlot {
  pos: Point;
  /** ptyId → slot, held for the life of the session. */
  lots: Record<string, number>;
  /** Slots whose session finished and closed; they keep the building. */
  built: number[];
}

export interface CityMapViewport {
  x: number;
  y: number;
  zoom: number;
}

/** A one-way road the user drew between two cities. */
export interface Road {
  id: string;
  from: number;
  to: number;
  note?: string;
}

/**
 * A named area of the map; cities inside it move with it. It lies on the
 * cities' own axes: `x`,`y` is the top corner, `w` runs down-right along
 * (1, ½) and `h` down-left along (−1, ½), so its edges follow the ground grid.
 */
export interface District {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number;
}

export interface CityMapProjectState {
  cities: Record<number, CityPlot>;
  viewport: CityMapViewport;
  roads: Road[];
  districts: District[];
}

export type CityMapSelection =
  | { type: 'city'; taskNumber: number }
  | { type: 'site'; taskNumber: number; ptyId: string }
  | { type: 'district'; id: string }
  | { type: 'road'; id: string };

export const DISTRICT_MIN_W = 200;
export const DISTRICT_MIN_H = 160;
export const DISTRICT_DEFAULT_W = 600;
export const DISTRICT_DEFAULT_H = 480;
const DISTRICT_HUES = [210, 28, 150, 330, 90, 260, 45, 190];

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A map offset as lengths along the two iso axes. */
export function isoDelta(dx: number, dy: number): { s: number; t: number } {
  return { s: (dx + 2 * dy) / 2, t: (2 * dy - dx) / 2 };
}

export function pointInDistrict(d: District, p: Point): boolean {
  const { s, t } = isoDelta(p.x - d.x, p.y - d.y);
  return s >= 0 && s <= d.w && t >= 0 && t <= d.h;
}

/** Top, right, bottom, left corners of the district's rhombus. */
export function districtCorners(d: District): [Point, Point, Point, Point] {
  return [
    { x: d.x, y: d.y },
    { x: d.x + d.w, y: d.y + d.w / 2 },
    { x: d.x + d.w - d.h, y: d.y + (d.w + d.h) / 2 },
    { x: d.x - d.h, y: d.y + d.h / 2 },
  ];
}

interface CityMapStoreState {
  byProject: Record<string, CityMapProjectState>;
  /** The terminal open in the drawer over the map, per project. */
  openPtyId: Record<string, string | null>;
  selection: Record<string, CityMapSelection | null>;
}

interface CityMapStoreActions {
  addRoad: (projectPath: string, from: number, to: number) => void;
  removeRoad: (projectPath: string, id: string) => void;
  updateRoad: (projectPath: string, id: string, patch: Partial<Omit<Road, 'id'>>) => void;
  addDistrict: (projectPath: string, center: Point) => District;
  updateDistrict: (projectPath: string, id: string, patch: Partial<Omit<District, 'id'>>) => void;
  /** Moves the district and the cities it holds by the same delta. */
  moveDistrict: (projectPath: string, id: string, delta: Point, taskNumbers: number[]) => void;
  removeDistrict: (projectPath: string, id: string) => void;
  ensureProject: (projectPath: string) => void;
  loadProject: (projectPath: string, state: CityMapProjectState) => void;
  ensureCity: (projectPath: string, taskNumber: number) => CityPlot;
  moveCity: (projectPath: string, taskNumber: number, pos: Point) => void;
  setViewport: (projectPath: string, viewport: CityMapViewport) => void;
  assignLot: (projectPath: string, taskNumber: number, ptyId: string) => void;
  releaseLot: (projectPath: string, ptyId: string, leaveBuilding: boolean) => void;
  setOpenPty: (projectPath: string, ptyId: string | null) => void;
  setSelection: (projectPath: string, selection: CityMapSelection | null) => void;
}

type CityMapStore = CityMapStoreState & CityMapStoreActions;

function emptyProjectState(): CityMapProjectState {
  return { cities: {}, viewport: { x: 0, y: 0, zoom: 0.9 }, roads: [], districts: [] };
}

/** A persisted state from before roads and districts existed still loads. */
export function normalizeProjectState(parsed: Partial<CityMapProjectState>): CityMapProjectState | null {
  if (!parsed.cities || !parsed.viewport) return null;
  return {
    cities: parsed.cities,
    viewport: parsed.viewport,
    roads: Array.isArray(parsed.roads) ? parsed.roads : [],
    districts: Array.isArray(parsed.districts) ? parsed.districts : [],
  };
}

export const useCityMapStore = create<CityMapStore>()((set, get) => {
  const update = (projectPath: string, fn: (state: CityMapProjectState) => CityMapProjectState) => {
    const current = get().byProject[projectPath] ?? emptyProjectState();
    set({ byProject: { ...get().byProject, [projectPath]: fn(current) } });
  };

  return {
    byProject: {},
    openPtyId: {},
    selection: {},

    ensureProject: (projectPath) => {
      if (get().byProject[projectPath]) return;
      update(projectPath, (s) => s);
    },

    loadProject: (projectPath, state) => {
      set({ byProject: { ...get().byProject, [projectPath]: state } });
    },

    ensureCity: (projectPath, taskNumber) => {
      const existing = get().byProject[projectPath]?.cities[taskNumber];
      if (existing) return existing;
      const others = Object.values(get().byProject[projectPath]?.cities ?? {}).map((c) => c.pos);
      const plot: CityPlot = { pos: freePosition(others), lots: {}, built: [] };
      update(projectPath, (s) => ({ ...s, cities: { ...s.cities, [taskNumber]: plot } }));
      return plot;
    },

    moveCity: (projectPath, taskNumber, pos) => {
      update(projectPath, (s) => {
        const city = s.cities[taskNumber];
        if (!city) return s;
        return { ...s, cities: { ...s.cities, [taskNumber]: { ...city, pos } } };
      });
    },

    setViewport: (projectPath, viewport) => {
      update(projectPath, (s) => ({ ...s, viewport }));
    },

    assignLot: (projectPath, taskNumber, ptyId) => {
      get().ensureCity(projectPath, taskNumber);
      update(projectPath, (s) => {
        const city = s.cities[taskNumber];
        if (city.lots[ptyId] != null) return s;
        const slot = nextFreeSlot([...Object.values(city.lots), ...city.built], cityLayout(taskNumber).slots.length);
        if (slot == null) return s;
        return { ...s, cities: { ...s.cities, [taskNumber]: { ...city, lots: { ...city.lots, [ptyId]: slot } } } };
      });
    },

    releaseLot: (projectPath, ptyId, leaveBuilding) => {
      update(projectPath, (s) => {
        const cities = { ...s.cities };
        let changed = false;
        for (const [key, city] of Object.entries(cities)) {
          const slot = city.lots[ptyId];
          if (slot == null) continue;
          const lots = { ...city.lots };
          delete lots[ptyId];
          cities[Number(key)] = { ...city, lots, built: leaveBuilding ? [...city.built, slot] : city.built };
          changed = true;
        }
        return changed ? { ...s, cities } : s;
      });
    },

    addRoad: (projectPath, from, to) => {
      if (from === to) return;
      update(projectPath, (s) => {
        if (s.roads.some((r) => r.from === from && r.to === to)) return s;
        return { ...s, roads: [...s.roads, { id: newId(), from, to }] };
      });
    },

    removeRoad: (projectPath, id) => {
      update(projectPath, (s) => ({ ...s, roads: s.roads.filter((r) => r.id !== id) }));
    },

    updateRoad: (projectPath, id, patch) => {
      update(projectPath, (s) => ({ ...s, roads: s.roads.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
    },

    addDistrict: (projectPath, center) => {
      const count = get().byProject[projectPath]?.districts.length ?? 0;
      const district: District = {
        id: newId(),
        name: `District ${count + 1}`,
        x: Math.round(center.x - (DISTRICT_DEFAULT_W - DISTRICT_DEFAULT_H) / 2),
        y: Math.round(center.y - (DISTRICT_DEFAULT_W + DISTRICT_DEFAULT_H) / 4),
        w: DISTRICT_DEFAULT_W,
        h: DISTRICT_DEFAULT_H,
        hue: DISTRICT_HUES[count % DISTRICT_HUES.length],
      };
      update(projectPath, (s) => ({ ...s, districts: [...s.districts, district] }));
      return district;
    },

    updateDistrict: (projectPath, id, patch) => {
      update(projectPath, (s) => ({
        ...s,
        districts: s.districts.map((d) =>
          d.id === id
            ? {
                ...d,
                ...patch,
                w: Math.max(DISTRICT_MIN_W, patch.w ?? d.w),
                h: Math.max(DISTRICT_MIN_H, patch.h ?? d.h),
              }
            : d,
        ),
      }));
    },

    moveDistrict: (projectPath, id, delta, taskNumbers) => {
      update(projectPath, (s) => {
        const cities = { ...s.cities };
        for (const n of taskNumbers) {
          const city = cities[n];
          if (city) cities[n] = { ...city, pos: { x: city.pos.x + delta.x, y: city.pos.y + delta.y } };
        }
        return {
          ...s,
          cities,
          districts: s.districts.map((d) => (d.id === id ? { ...d, x: d.x + delta.x, y: d.y + delta.y } : d)),
        };
      });
    },

    removeDistrict: (projectPath, id) => {
      update(projectPath, (s) => ({ ...s, districts: s.districts.filter((d) => d.id !== id) }));
    },

    setOpenPty: (projectPath, ptyId) => {
      set({ openPtyId: { ...get().openPtyId, [projectPath]: ptyId } });
    },

    setSelection: (projectPath, selection) => {
      set({ selection: { ...get().selection, [projectPath]: selection } });
    },
  };
});

// ── Persistence ──────────────────────────────────────────────────────

const STORAGE_PREFIX = 'citymap:';
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function persistCityMap(projectPath: string): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const state = useCityMapStore.getState().byProject[projectPath];
    if (!state) return;
    window.api.globalSettings.set(STORAGE_PREFIX + projectPath, JSON.stringify(state));
  }, 300);
}

export async function loadPersistedCityMap(projectPath: string): Promise<CityMapProjectState | null> {
  const json = await window.api.globalSettings.get(STORAGE_PREFIX + projectPath);
  if (!json) return null;
  try {
    return normalizeProjectState(JSON.parse(json) as Partial<CityMapProjectState>);
  } catch {
    return null;
  }
}

// ── Sync with terminals ──────────────────────────────────────────────

/**
 * What each terminal last reported, so a terminal that has gone can still be
 * told apart: one that finished leaves a building, one that was closed
 * mid-work frees its lot.
 */
const lastSummary = new Map<string, TerminalDisplayState['summaryType']>();

export function syncCityMapWithTerminals(
  projectPath: string,
  displayStates: Record<string, TerminalDisplayState>,
  terminalIds: readonly string[],
): void {
  const store = useCityMapStore.getState();
  store.ensureProject(projectPath);
  const live = new Set<string>();
  for (const ptyId of terminalIds) {
    const display = displayStates[ptyId];
    if (!display || display.isLoading || display.taskId == null) continue;
    live.add(ptyId);
    lastSummary.set(ptyId, display.summaryType);
    store.assignLot(projectPath, display.taskId, ptyId);
  }

  let changed = false;
  const cities = useCityMapStore.getState().byProject[projectPath]?.cities ?? {};
  for (const city of Object.values(cities)) {
    for (const ptyId of Object.keys(city.lots)) {
      if (live.has(ptyId)) continue;
      useCityMapStore.getState().releaseLot(projectPath, ptyId, lastSummary.get(ptyId) === 'success');
      lastSummary.delete(ptyId);
      changed = true;
    }
  }
  if (changed || terminalIds.length > 0) persistCityMap(projectPath);
}
