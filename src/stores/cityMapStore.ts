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

export interface CityMapProjectState {
  cities: Record<number, CityPlot>;
  viewport: CityMapViewport;
}

export type CityMapSelection =
  | { type: 'city'; taskNumber: number }
  | { type: 'site'; taskNumber: number; ptyId: string };

interface CityMapStoreState {
  byProject: Record<string, CityMapProjectState>;
  /** The terminal open in the drawer over the map, per project. */
  openPtyId: Record<string, string | null>;
  selection: Record<string, CityMapSelection | null>;
}

interface CityMapStoreActions {
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
  return { cities: {}, viewport: { x: 0, y: 0, zoom: 0.9 } };
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
    const parsed = JSON.parse(json) as Partial<CityMapProjectState>;
    if (!parsed.cities || !parsed.viewport) return null;
    return { cities: parsed.cities, viewport: parsed.viewport };
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
