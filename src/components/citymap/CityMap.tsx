import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { terminalMatchesTag, useTerminalStore } from '../../stores/terminalStore';
import {
  useUIStore,
  CITY_MAP_SIDEBAR_DEFAULT_WIDTH,
  CITY_MAP_SIDEBAR_MAX_WIDTH,
  CITY_MAP_SIDEBAR_MIN_WIDTH,
  CITY_MAP_DRAWER_DEFAULT_WIDTH,
  CITY_MAP_DRAWER_MAX_WIDTH,
  CITY_MAP_DRAWER_MIN_WIDTH,
  type CityMapSidebarGroup,
} from '../../stores/uiStore';
import { ResizeHandle } from '../common/ResizeHandle';
import type { TerminalDisplayState } from '../../stores/terminalDisplay';
import {
  DISTRICT_TERRAINS,
  DISTRICT_TERRAIN_HUE,
  districtCorners,
  isoDelta,
  loadPersistedCityMap,
  persistCityMap,
  pointInDistrict,
  syncCityMapWithTerminals,
  useCityMapStore,
  type CityMapSelection,
  type CityMapViewport,
  type CityPlot,
  type District,
  type DistrictTerrain,
  type Road,
} from '../../stores/cityMapStore';
import type { SandboxProviderId, TaskStatus, TaskWithWorkspace } from '../../types';
import { buildChainMap, getChainColor } from '../../utils/taskChain';
import { useThemeEpoch } from '../../hooks/useResolvedTheme';
import { Icon } from '../terminal/Icon';
import { TerminalHeader } from '../terminal/TerminalHeader';
import { TerminalBody } from '../terminal/TerminalBody';
import { closeProjectTerminal, renameTerminal } from '../terminal/terminalActions';
import { terminalInstances } from '../terminal/terminalReact';
import { ContextMenu, type ContextMenuEntry } from '../ui/ContextMenu';
import { openInEntry, moveToEntry, STATUS_LABELS, type TaskMenuActions } from '../kanban/taskMenu';
import { openTaskShell } from '../navigation';
import { openTaskInEditor } from '../../services/openInEditor';
import { completeTask } from '../../services/taskCompletion';
import { archiveTasks, deleteTasks } from '../../services/taskArchive';
import { bulkTransitionTasks } from '../../services/taskStartService';
import { revealInFileManager } from '../../utils/fileManager';
import { openTaskComposer } from '../../utils/openTaskComposer';
import { ArchivedTaskList } from '../kanban/ArchivedTasks';
import { TaskComments } from '../kanban/TaskComments';
import { latestComment, selectTaskComments, useTaskCommentStore } from '../../stores/taskCommentStore';
import {
  BIOME_LABEL,
  CITY_HALF_H,
  CITY_HALF_W,
  CULTURE_LABEL,
  SEASON_LABEL,
  SITE_STATE_LABEL,
  TH,
  TW,
  cellCenter,
  cityLayout,
  cityPresence,
  cityStyle,
  pointInCity,
  seasonFor,
  siteState,
  snapToCells,
  weatherFor,
  type CityStyle,
  type Point,
  type Season,
  type SiteState,
  type Weather,
  WEATHER_LABEL,
} from './cityGeometry';
import {
  districtColor,
  drawCity,
  drawDistrict,
  drawGrid,
  drawPath,
  drawRoad,
  roadSpan,
  routeMidpoint,
  carsFor,
  CAR_COLOURS,
  CRANE,
  drawSelectionRing,
  withAlpha,
  type DrawCity,
  type MapTokens,
} from './drawCity';
import { DetailLayer, TerrainLayer } from './drawTerrain';
import { CITY_BITMAP_ZOOM, CityBitmaps } from './cityLod';
import { cellKey, daylightTint, roadRoute, routeCells, windowsLit } from './terrain';

const EMPTY_IDS: string[] = [];
const EMPTY_ROADS: Road[] = [];
const EMPTY_DISTRICTS: District[] = [];
const STATUS_ORDER: TaskStatus[] = ['in_progress', 'in_review', 'todo', 'done'];
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.6;
const DISTRICT_TERRAIN_LABEL: Record<DistrictTerrain, string> = {
  blossom: 'Cherry grove',
  volcanic: 'Volcanic',
  marsh: 'Marsh',
  glacier: 'Glacier',
  mushroom: 'Mushroom wood',
  salt: 'Salt flats',
};
const FLASH_MS = 2500;
const MINIMAP_W = 180;
const MINIMAP_H = 110;

interface SiteModel {
  ptyId: string;
  slot: number;
  state: SiteState;
  label: string;
  display: TerminalDisplayState;
}

interface CityModel {
  task: TaskWithWorkspace;
  plot: CityPlot;
  color: string;
  sites: SiteModel[];
  style: CityStyle;
  season: Season;
  weather: Weather;
  /** Filtered out by the project's tag filter: drawn faint, listed nowhere. */
  hidden: boolean;
}

const TOKEN_SOURCES: Record<Exclude<keyof MapTokens, 'night' | 'lit'>, string> = {
  ground: 'color-mix(in srgb, var(--color-background) 84%, var(--color-success))',
  groundLine: 'color-mix(in srgb, var(--color-ink) 7%, transparent)',
  water: 'color-mix(in srgb, var(--color-background) 55%, var(--color-accent))',
  path: 'color-mix(in srgb, var(--color-ink) 22%, transparent)',
  surface: 'var(--color-surface-raised)',
  ink: 'var(--color-text-primary)',
  ink2: 'var(--color-text-secondary)',
  accent: 'var(--color-accent)',
  working: 'var(--color-status-thinking)',
  waiting: 'var(--color-ansi-yellow)',
  error: 'var(--color-error)',
  done: 'var(--color-success)',
  exited: 'var(--color-text-tertiary)',
  review: 'var(--color-ansi-magenta)',
};

/**
 * Canvas fill styles take plain colours only, so every token is resolved
 * through a probe element the stylesheet paints.
 */
function resolveTokens(probe: HTMLElement): MapTokens {
  const style = probe.style;
  const read = (css: string): string => {
    style.color = css;
    return getComputedStyle(probe).color;
  };
  const tokens = {} as MapTokens;
  for (const [key, css] of Object.entries(TOKEN_SOURCES)) {
    tokens[key as Exclude<keyof MapTokens, 'night' | 'lit'>] = read(css);
  }
  const bg = read('var(--color-background)')
    .match(/\d+(\.\d+)?/g)
    ?.map(Number) ?? [255, 255, 255];
  tokens.night = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255 < 0.5;
  tokens.lit = tokens.night;
  return tokens;
}

function siteLabel(display: TerminalDisplayState): string {
  return display.label || display.lastOscTitle || 'Shell';
}

function selectedTaskNumber(selection: CityMapSelection | null): number | null {
  return selection && (selection.type === 'city' || selection.type === 'site') ? selection.taskNumber : null;
}

function citiesInside(district: District, cities: readonly CityModel[]): CityModel[] {
  return cities.filter((c) => pointInDistrict(district, c.plot.pos));
}

function needsYou(state: SiteState): boolean {
  return state === 'waiting' || state === 'error';
}

/** Cities the road leads from that are not finished: what the destination is waiting on. */
function openSources(city: CityModel, roads: readonly Road[], byNumber: Map<number, CityModel>): CityModel[] {
  const sources: CityModel[] = [];
  for (const road of roads) {
    if (road.to !== city.task.taskNumber) continue;
    const from = byNumber.get(road.from);
    if (from && from.task.status !== 'done') sources.push(from);
  }
  return sources;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/**
 * The board's status change, not a bare write: it creates the worktree, opens
 * the terminal and runs the start, continue or review hook the way a drop on
 * a column does.
 */
function transitionTask(projectPath: string, task: TaskWithWorkspace, status: TaskStatus): void {
  if (task.status === status) return;
  void bulkTransitionTasks(projectPath, [task.taskNumber], status);
}

interface CityMapProps {
  projectPath: string;
}

export function CityMap({ projectPath }: CityMapProps) {
  const tasks = useProjectStore((s) => s.tasks);
  const tagFilter = useProjectStore((s) => s.tagFilter);
  const availableSandboxProviders = useProjectStore((s) => s.availableSandboxProviders);
  const displayStates = useTerminalStore((s) => s.displayStates);
  const terminalIds = useTerminalStore((s) => s.terminalsByProject[projectPath]) ?? EMPTY_IDS;
  const mapState = useCityMapStore((s) => s.byProject[projectPath]);
  const selection = useCityMapStore((s) => s.selection[projectPath] ?? null);
  const openPtyId = useCityMapStore((s) => s.openPtyId[projectPath] ?? null);
  const [ready, setReady] = useState(false);

  // Persisted positions first, so a city is not founded twice.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    useCityMapStore.getState().ensureProject(projectPath);
    loadPersistedCityMap(projectPath).then((saved) => {
      if (cancelled) return;
      if (saved) useCityMapStore.getState().loadProject(projectPath, saved);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!ready) return;
    const store = useCityMapStore.getState();
    let founded = false;
    for (const task of tasks) {
      if (!store.byProject[projectPath]?.cities[task.taskNumber]) {
        store.ensureCity(projectPath, task.taskNumber);
        founded = true;
      }
    }
    if (founded) persistCityMap(projectPath);
  }, [ready, tasks, projectPath]);

  useEffect(() => {
    if (!ready) return;
    syncCityMapWithTerminals(projectPath, displayStates, terminalIds);
  }, [ready, displayStates, terminalIds, projectPath]);

  const chainMap = useMemo(() => buildChainMap(tasks), [tasks]);
  const cities = useMemo((): CityModel[] => {
    if (!mapState) return [];
    const result: CityModel[] = [];
    for (const task of tasks) {
      const plot = mapState.cities[task.taskNumber];
      if (!plot) continue;
      const info = chainMap.get(task.taskNumber);
      const color = info ? getChainColor(info.rootTaskNumber, info.depth) : getChainColor(task.taskNumber, 0);
      const sites: SiteModel[] = [];
      for (const [ptyId, slot] of Object.entries(plot.lots)) {
        const display = displayStates[ptyId];
        if (!display) continue;
        sites.push({ ptyId, slot, state: siteState(display), label: siteLabel(display), display });
      }
      const hidden = !!tagFilter && !sites.some((s) => terminalMatchesTag(s.display, tagFilter));
      result.push({
        task,
        plot,
        color,
        sites,
        style: cityStyle(info?.rootTaskNumber ?? task.taskNumber),
        season: seasonFor(task.createdAt),
        weather: weatherFor(sites.map((s) => s.state)),
        hidden,
      });
    }
    return result;
  }, [mapState, tasks, chainMap, displayStates, tagFilter]);
  const roads = mapState?.roads ?? EMPTY_ROADS;
  const districts = mapState?.districts ?? EMPTY_DISTRICTS;

  // A site that just started needing the user lights its city's label up.
  const [flashing, setFlashing] = useState<Record<number, number>>({});
  const previousStates = useRef<Map<string, SiteState>>(new Map());
  useEffect(() => {
    const next = new Map<string, SiteState>();
    const lit: number[] = [];
    for (const city of cities) {
      for (const site of city.sites) {
        next.set(site.ptyId, site.state);
        const before = previousStates.current.get(site.ptyId);
        if (before && before !== site.state && needsYou(site.state)) lit.push(city.task.taskNumber);
      }
    }
    previousStates.current = next;
    if (!lit.length) return;
    const now = Date.now();
    setFlashing((f) => ({ ...f, ...Object.fromEntries(lit.map((n) => [n, now])) }));
    const timer = setTimeout(
      () =>
        setFlashing((f) => {
          const kept: Record<number, number> = {};
          for (const [n, at] of Object.entries(f)) if (at !== now) kept[Number(n)] = at;
          return kept;
        }),
      FLASH_MS,
    );
    return () => clearTimeout(timer);
  }, [cities]);

  const looseTerminals = useMemo(
    () =>
      terminalIds.filter((id) => displayStates[id] && !displayStates[id].isLoading && displayStates[id].taskId == null)
        .length,
    [terminalIds, displayStates],
  );

  const select = useCallback(
    (next: CityMapSelection | null) => useCityMapStore.getState().setSelection(projectPath, next),
    [projectPath],
  );
  const openTerminal = useCallback(
    (ptyId: string | null) => {
      useCityMapStore.getState().setOpenPty(projectPath, ptyId);
      if (ptyId) {
        requestAnimationFrame(() => {
          const inst = terminalInstances.get(ptyId);
          if (inst) {
            inst.fit();
            inst.xterm.focus();
          }
        });
      }
    },
    [projectPath],
  );

  // A terminal the selected city just gained, such as the one a status change
  // opened, shows up in the drawer the way the board shows it in the stack.
  const knownSites = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = new Set<string>();
    let fresh: { taskNumber: number; ptyId: string } | null = null;
    for (const city of cities) {
      for (const site of city.sites) {
        seen.add(site.ptyId);
        if (knownSites.current && !knownSites.current.has(site.ptyId)) {
          fresh = { taskNumber: city.task.taskNumber, ptyId: site.ptyId };
        }
      }
    }
    const before = knownSites.current;
    knownSites.current = seen;
    if (!before || !fresh) return;
    const current = useCityMapStore.getState().selection[projectPath];
    if (!current || current.type === 'district' || current.type === 'road' || current.taskNumber !== fresh.taskNumber) {
      return;
    }
    select({ type: 'site', taskNumber: fresh.taskNumber, ptyId: fresh.ptyId });
    openTerminal(fresh.ptyId);
  }, [cities, projectPath, select, openTerminal]);

  const sidebarWidth = useUIStore((s) => s.cityMapSidebarWidth);
  const drawerWidth = useUIStore((s) => s.cityMapDrawerWidth);
  const drawerOpen = !!openPtyId && !!displayStates[openPtyId];
  // The drawer sits over the inspector, so whichever is open is what covers the map.
  const coverRight = drawerOpen ? drawerWidth + 12 : selection ? INSPECTOR_COVER : 0;
  const surface = useMapSurface({
    projectPath,
    ready,
    cities,
    roads,
    districts,
    selection,
    flashing,
    viewport: mapState?.viewport,
    coverRight,
    select,
    openTerminal,
    availableSandboxProviders,
  });
  // The light of the day lies over the map as a blended layer: it changes by
  // the minute, and it is not worth painting into every frame.
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const tint = daylightTint(clock, surface.night);
  const {
    canvasRef,
    groundRef,
    containerRef,
    probeRef,
    minimapRef,
    labels,
    flyTo,
    fitAll,
    onContextMenu,
    menu,
    closeMenu,
    linking,
    cancelLinking,
  } = surface;

  const taskNumber = selectedTaskNumber(selection);
  const selectedCity = taskNumber != null ? cities.find((c) => c.task.taskNumber === taskNumber) : undefined;
  const selectedSite =
    selection?.type === 'site' && selectedCity
      ? selectedCity.sites.find((s) => s.ptyId === selection.ptyId)
      : undefined;
  const selectedDistrict = selection?.type === 'district' ? districts.find((d) => d.id === selection.id) : undefined;
  const selectedRoad = selection?.type === 'road' ? roads.find((r) => r.id === selection.id) : undefined;
  const linkingCity = linking != null ? cities.find((c) => c.task.taskNumber === linking) : undefined;
  const byNumber = useMemo(() => new Map(cities.map((c) => [c.task.taskNumber, c])), [cities]);

  const sidebarGroup = useUIStore((s) => s.cityMapSidebarGroup);

  return (
    <div
      className="flex h-full min-h-0 transition-[margin-left] duration-200 ease-out"
      style={{ marginLeft: 'var(--sidebar-offset, 0px)' }}
      data-testid="city-map"
    >
      <CitySidebar
        projectPath={projectPath}
        width={sidebarWidth}
        cities={cities}
        districts={districts}
        group={sidebarGroup}
        selection={selection}
        looseTerminals={looseTerminals}
        tagFilter={tagFilter}
        onPick={(city) => {
          select({ type: 'city', taskNumber: city.task.taskNumber });
          flyTo(city.plot.pos, 1.1);
        }}
        onPickSite={(city, site) => {
          select({ type: 'site', taskNumber: city.task.taskNumber, ptyId: site.ptyId });
          const { slots } = cityLayout(city.task.taskNumber);
          const c = cellCenter(slots[site.slot].i, slots[site.slot].j);
          flyTo({ x: city.plot.pos.x + c.x, y: city.plot.pos.y + c.y }, 1.5);
          openTerminal(site.ptyId);
        }}
        onPickDistrict={(district) => {
          select({ type: 'district', id: district.id });
          const [top, , bottom] = districtCorners(district);
          flyTo({ x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 - 10 }, 0);
        }}
      />
      <ResizeHandle
        width={sidebarWidth}
        onWidth={(width) => useUIStore.getState().setCityMapSidebarWidth(width)}
        min={CITY_MAP_SIDEBAR_MIN_WIDTH}
        max={CITY_MAP_SIDEBAR_MAX_WIDTH}
        defaultWidth={CITY_MAP_SIDEBAR_DEFAULT_WIDTH}
        label="Resize the city list"
      />
      <div ref={containerRef} className="relative flex-1 min-w-0 overflow-hidden">
        <span ref={probeRef} className="absolute w-0 h-0 pointer-events-none" aria-hidden="true" />
        <canvas ref={groundRef} className="absolute inset-0 w-full h-full block" aria-hidden="true" />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full block touch-none"
          aria-label="Map of tasks as cities"
        />
        {tint && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: tint.colour, mixBlendMode: tint.op as CSSProperties['mixBlendMode'] }}
            data-testid="daylight-tint"
          />
        )}
        <div className="absolute inset-0 pointer-events-none">{labels}</div>
        {linkingCity && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-1.5 rounded-full border border-accent text-xs"
            style={{ background: 'var(--color-surface-raised)', boxShadow: 'var(--shadow-panel)' }}
            data-testid="road-hint"
          >
            <span className="text-text-primary">
              Road from <strong>#{linkingCity.task.taskNumber}</strong>: click the city it leads to
            </span>
            <button type="button" className="text-text-tertiary hover:text-text-primary" onClick={cancelLinking}>
              Cancel
            </button>
          </div>
        )}
        <div className="absolute left-3 bottom-3 z-10 flex items-center gap-1.5">
          <button
            type="button"
            className="px-2.5 py-1 rounded-md border border-border text-[11px] text-text-secondary hover:text-text-primary"
            style={{ background: 'var(--color-surface-raised)', boxShadow: 'var(--shadow-panel)' }}
            onClick={fitAll}
            data-testid="fit-all"
            title="Bring every city into view"
          >
            Fit all
          </button>
          <button
            type="button"
            className="px-2.5 py-1 rounded-md border border-border text-[11px] font-mono text-text-secondary hover:text-text-primary"
            style={{ background: 'var(--color-surface-raised)', boxShadow: 'var(--shadow-panel)' }}
            onClick={() => flyTo(selectedCity?.plot.pos ?? { x: 0, y: 0 }, 1)}
            title="Zoom to 100%"
          >
            1:1
          </button>
          {tagFilter && (
            <span
              className="px-2.5 py-1 rounded-md border border-border text-[11px] text-text-secondary"
              style={{ background: 'var(--color-surface-raised)' }}
            >
              Showing cities tagged <strong className="text-text-primary">{tagFilter}</strong>
            </span>
          )}
        </div>
        <canvas
          ref={minimapRef}
          className="absolute right-3 bottom-3 z-10 rounded-[10px] border border-border cursor-crosshair"
          style={{ width: MINIMAP_W, height: MINIMAP_H, background: 'var(--color-surface-raised)' }}
          aria-label="Overview of the map"
          data-testid="minimap"
        />
        {selectedCity && (
          <CityInspector
            projectPath={projectPath}
            city={selectedCity}
            site={selectedSite}
            district={districts.find((d) => pointInDistrict(d, selectedCity.plot.pos))}
            waitingOn={openSources(selectedCity, roads, byNumber)}
            onClose={() => select(null)}
            onSelectSite={(site) => {
              select({ type: 'site', taskNumber: selectedCity.task.taskNumber, ptyId: site.ptyId });
              openTerminal(site.ptyId);
            }}
            onBackToCity={() => select({ type: 'city', taskNumber: selectedCity.task.taskNumber })}
            onOpenTerminal={openTerminal}
            onPickCity={(city) => {
              select({ type: 'city', taskNumber: city.task.taskNumber });
              flyTo(city.plot.pos, 0);
            }}
            onContextMenu={onContextMenu}
          />
        )}
        {selectedDistrict && (
          <DistrictInspector
            projectPath={projectPath}
            district={selectedDistrict}
            cities={citiesInside(selectedDistrict, cities)}
            onClose={() => select(null)}
            onPickCity={(city) => {
              select({ type: 'city', taskNumber: city.task.taskNumber });
              flyTo(city.plot.pos, 1.1);
            }}
          />
        )}
        {selectedRoad && (
          <RoadInspector
            projectPath={projectPath}
            road={selectedRoad}
            from={byNumber.get(selectedRoad.from)}
            to={byNumber.get(selectedRoad.to)}
            onClose={() => select(null)}
            onPickCity={(city) => {
              select({ type: 'city', taskNumber: city.task.taskNumber });
              flyTo(city.plot.pos, 0);
            }}
          />
        )}
        {drawerOpen && (
          <TerminalDrawer
            ptyId={openPtyId}
            projectPath={projectPath}
            width={drawerWidth}
            onHide={() => openTerminal(null)}
          />
        )}
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      </div>
    </div>
  );
}

// ── Map surface: camera, drawing, hit testing, labels ────────────────

interface MapSurfaceInput {
  projectPath: string;
  /** Whether the persisted state has been loaded; the viewport is adopted only from that. */
  ready: boolean;
  cities: CityModel[];
  roads: Road[];
  districts: District[];
  selection: CityMapSelection | null;
  flashing: Record<number, number>;
  viewport: CityMapViewport | undefined;
  /** Width of the panels laid over the map's right edge, which a centred city must clear. */
  coverRight: number;
  select: (s: CityMapSelection | null) => void;
  openTerminal: (ptyId: string | null) => void;
  availableSandboxProviders: SandboxProviderId[];
}

type Hit =
  | { type: 'city'; city: CityModel }
  | { type: 'site'; city: CityModel; site: SiteModel }
  | { type: 'road'; road: Road }
  | { type: 'district'; district: District }
  | { type: 'districtCorner'; district: District }
  | null;

function useMapSurface(input: MapSurfaceInput) {
  const { projectPath, ready, cities, roads, districts, selection, flashing, viewport, select, openTerminal } = input;
  const cover = useRef(input.coverRight);
  cover.current = input.coverRight;
  /** What the camera was last sent to, kept centred while the panels around the map change. */
  const focus = useRef<{ target: Point; zoom: number } | null>(null);
  const commentsByTask = useTaskCommentStore((s) => s.byTask);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groundRef = useRef<HTMLCanvasElement>(null);
  /** What the ground canvas was last painted for; the same again means it is left alone. */
  const groundKey = useRef('');
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const camera = useRef<CityMapViewport>({ x: 0, y: 0, zoom: 0.9 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const tokens = useRef<MapTokens | null>(null);
  const [night, setNight] = useState(false);
  const terrain = useRef(new TerrainLayer());
  const details = useRef(new DetailLayer());
  const bitmaps = useRef(new CityBitmaps());
  const dirty = useRef(true);
  const tween = useRef<{ from: CityMapViewport; to: CityMapViewport; t0: number } | null>(null);
  const model = useRef({ cities, roads, districts, selection });
  model.current = { cities, roads, districts, selection };
  const minimapMap = useRef<{ scale: number; ox: number; oy: number } | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const linkingRef = useRef<number | null>(null);
  linkingRef.current = linking;
  const themeEpoch = useThemeEpoch();

  // The persisted viewport arrives after mount, behind the project's default
  // one; adopt it once per project, and only once it has actually loaded.
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !viewport || adopted.current === projectPath) return;
    adopted.current = projectPath;
    camera.current = { ...viewport };
    dirty.current = true;
    bump();
  }, [ready, viewport, projectPath]);

  useEffect(() => {
    if (probeRef.current) {
      tokens.current = resolveTokens(probeRef.current);
      setNight(tokens.current.night);
    }
    dirty.current = true;
  }, [themeEpoch]);

  useEffect(() => {
    dirty.current = true;
  }, [cities, roads, districts, selection]);

  useEffect(() => {
    if (linking == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinking(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [linking]);

  const toScreen = useCallback((p: Point): Point => {
    const c = camera.current;
    return { x: (p.x - c.x) * c.zoom + size.current.w / 2, y: (p.y - c.y) * c.zoom + size.current.h / 2 };
  }, []);
  const toWorld = useCallback((sx: number, sy: number): Point => {
    const c = camera.current;
    return { x: (sx - size.current.w / 2) / c.zoom + c.x, y: (sy - size.current.h / 2) / c.zoom + c.y };
  }, []);

  const saveViewport = useCallback(() => {
    useCityMapStore.getState().setViewport(projectPath, { ...camera.current });
    persistCityMap(projectPath);
  }, [projectPath]);

  const glide = useCallback(
    (to: CityMapViewport) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        camera.current = to;
        dirty.current = true;
        bump();
        saveViewport();
        return;
      }
      tween.current = { from: { ...camera.current }, to, t0: performance.now() };
    },
    [saveViewport],
  );

  // The centre of what the panels leave visible, not of the canvas: a panel
  // over the right edge shifts it left by half its width, in map units.
  const flyTo = useCallback(
    (target: Point, zoom: number) => {
      const level = zoom > 0 ? Math.max(camera.current.zoom, zoom) : camera.current.zoom;
      focus.current = { target, zoom: level };
      glide({ x: target.x + cover.current / (2 * level), y: target.y + 10, zoom: level });
    },
    [glide],
  );

  useEffect(() => {
    if (focus.current) flyTo(focus.current.target, 0);
  }, [input.coverRight, flyTo]);

  const mapBounds = useCallback(() => {
    const { cities: current, districts: currentDistricts } = model.current;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of current) {
      x0 = Math.min(x0, c.plot.pos.x - CITY_HALF_W);
      y0 = Math.min(y0, c.plot.pos.y - CITY_HALF_H - 60);
      x1 = Math.max(x1, c.plot.pos.x + CITY_HALF_W);
      y1 = Math.max(y1, c.plot.pos.y + CITY_HALF_H);
    }
    for (const d of currentDistricts) {
      for (const p of districtCorners(d)) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    if (!Number.isFinite(x0)) return { x0: -400, y0: -300, x1: 400, y1: 300 };
    return { x0, y0, x1, y1 };
  }, []);

  const fitAll = useCallback(() => {
    const b = mapBounds();
    const { w, h } = size.current;
    const width = Math.max(120, w - cover.current);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(width / (b.x1 - b.x0 + 120), h / (b.y1 - b.y0 + 120))));
    focus.current = null;
    glide({ x: (b.x0 + b.x1) / 2 + cover.current / (2 * zoom), y: (b.y0 + b.y1) / 2, zoom });
  }, [glide, mapBounds]);

  // Resize + draw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      const r = container.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ground = groundRef.current;
      if (ground) {
        ground.width = canvas.width;
        ground.height = canvas.height;
      }
      groundKey.current = '';
      dirty.current = true;
      bump();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const drawMinimap = () => {
      const mini = minimapRef.current;
      const mctx = mini?.getContext('2d');
      const t = tokens.current;
      if (!mini || !mctx || !t) return;
      const dpr = size.current.dpr;
      if (mini.width !== MINIMAP_W * dpr) {
        mini.width = MINIMAP_W * dpr;
        mini.height = MINIMAP_H * dpr;
      }
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
      const b = mapBounds();
      const pad = 12;
      const scale = Math.min((MINIMAP_W - pad * 2) / (b.x1 - b.x0), (MINIMAP_H - pad * 2) / (b.y1 - b.y0));
      const ox = MINIMAP_W / 2 - ((b.x0 + b.x1) / 2) * scale;
      const oy = MINIMAP_H / 2 - ((b.y0 + b.y1) / 2) * scale;
      const M = (p: Point) => ({ x: ox + p.x * scale, y: oy + p.y * scale });
      minimapMap.current = { scale, ox, oy };
      const { cities: current, districts: currentDistricts } = model.current;
      for (const d of currentDistricts) {
        const corners = districtCorners(d).map(M);
        mctx.beginPath();
        corners.forEach((c, i) => (i ? mctx.lineTo(c.x, c.y) : mctx.moveTo(c.x, c.y)));
        mctx.closePath();
        mctx.fillStyle = districtColor(d.hue, 0.25, t.night);
        mctx.fill();
      }
      for (const c of current) {
        const p = M(c.plot.pos);
        mctx.globalAlpha = c.hidden ? 0.25 : c.task.status === 'done' ? 0.55 : 1;
        mctx.fillStyle = c.color;
        mctx.beginPath();
        mctx.moveTo(p.x, p.y - 4);
        mctx.lineTo(p.x + 6, p.y);
        mctx.lineTo(p.x, p.y + 4);
        mctx.lineTo(p.x - 6, p.y);
        mctx.closePath();
        mctx.fill();
        mctx.globalAlpha = 1;
        const alert = c.sites.find((s) => needsYou(s.state));
        if (alert && !c.hidden) {
          mctx.fillStyle = alert.state === 'error' ? t.error : t.waiting;
          mctx.beginPath();
          mctx.arc(p.x + 5, p.y - 4, 2.5, 0, Math.PI * 2);
          mctx.fill();
        }
      }
      const a = M(toWorld(0, 0));
      const z = M(toWorld(size.current.w, size.current.h));
      mctx.strokeStyle = t.ink;
      mctx.globalAlpha = 0.6;
      mctx.lineWidth = 1;
      mctx.strokeRect(a.x, a.y, z.x - a.x, z.y - a.y);
      mctx.globalAlpha = 1;
    };

    let frame = 0;
    const draw = () => {
      const t = tokens.current;
      const { w, h, dpr } = size.current;
      const cam = camera.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const tl = toWorld(0, 0);
      const br = toWorld(w, h);
      const visible = { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
      const world = [
        dpr * cam.zoom,
        0,
        0,
        dpr * cam.zoom,
        dpr * (w / 2 - cam.x * cam.zoom),
        dpr * (h / 2 - cam.y * cam.zoom),
      ] as const;
      ctx.setTransform(...world);
      const { cities: current, roads: currentRoads, districts: currentDistricts, selection: sel } = model.current;
      const now = new Date();
      t.lit = windowsLit(now, t.night);
      const byNumber = new Map(current.map((c) => [c.task.taskNumber, c]));
      const selectedTask = selectedTaskNumber(sel);
      const routes = currentRoads.flatMap((road) => {
        const from = byNumber.get(road.from);
        const to = byNumber.get(road.to);
        if (!from || !to) return [];
        const touches =
          (sel?.type === 'road' && sel.id === road.id) ||
          (selectedTask != null && (road.from === selectedTask || road.to === selectedTask));
        return [{ road, touches, route: roadRoute(from.plot.pos, to.plot.pos) }];
      });
      const roadCells = new Set(routes.flatMap((r) => routeCells(r.route).map(cellKey)));
      // The ground moves only with the camera and the world; animation frames leave it be.
      const groundCtx = groundRef.current?.getContext('2d');
      const selectedDistrict = sel?.type === 'district' ? sel.id : '';
      const key = [
        cam.x,
        cam.y,
        cam.zoom,
        w,
        h,
        dpr,
        t.night,
        t.ground,
        selectedDistrict,
        currentDistricts.map((d) => `${d.id},${d.x},${d.y},${d.w},${d.h},${d.terrain}`).join(';'),
        current.map((c) => `${c.plot.pos.x},${c.plot.pos.y}`).join(';'),
        roadCells.size,
      ].join('|');
      if (groundCtx && key !== groundKey.current) {
        groundKey.current = key;
        groundCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        groundCtx.fillStyle = t.ground;
        groundCtx.fillRect(0, 0, w, h);
        groundCtx.setTransform(...world);
        terrain.current.draw(groundCtx, t, visible, cam.zoom, currentDistricts);
        drawGrid(groundCtx, t, visible, cam.zoom);
        for (const d of currentDistricts) {
          drawDistrict(groundCtx, t, d, sel?.type === 'district' && sel.id === d.id, cam.zoom);
        }
        details.current.draw(
          groundCtx,
          t,
          visible,
          cam.zoom,
          currentDistricts,
          current.map((c) => c.plot.pos),
          roadCells,
        );
      }
      for (const city of current) {
        const parent = city.task.parentTaskNumber != null ? byNumber.get(city.task.parentTaskNumber) : undefined;
        if (parent) drawPath(ctx, t, parent.plot.pos, city.plot.pos);
      }
      const roadDraws = routes.map(({ road, touches, route }) => {
        const span = roadSpan(route);
        return (band: { y0: number; y1: number }) => {
          if (span.y1 < band.y0 || span.y0 >= band.y1) return;
          drawRoad(ctx, t, route, touches, `#${road.to}`, band);
        };
      });
      const ordered = [...current].sort((a, b) => a.plot.pos.y - b.plot.pos.y);
      let painted = -Infinity;
      const roadsUpTo = (y: number) => {
        if (y <= painted) return;
        const band = { y0: painted, y1: y };
        for (const draw of roadDraws) draw(band);
        painted = y;
      };
      for (const city of ordered) {
        const p = city.plot.pos;
        roadsUpTo(p.y);
        if (
          p.x + CITY_HALF_W < tl.x - 60 ||
          p.x - CITY_HALF_W > br.x + 60 ||
          p.y + CITY_HALF_H < tl.y - 120 ||
          p.y - CITY_HALF_H > br.y + 100
        )
          continue;
        if (city.hidden) ctx.globalAlpha = 0.22;
        if (selectedTask === city.task.taskNumber || linkingRef.current === city.task.taskNumber) {
          drawSelectionRing(ctx, t, p, cam.zoom);
        }
        const drawable: DrawCity = {
          taskNumber: city.task.taskNumber,
          presence: cityPresence(city.task.status),
          pos: p,
          color: city.color,
          sites: city.sites.map((s) => ({ slot: s.slot, state: s.state })),
          built: city.plot.built,
          style: city.style,
          season: city.season,
          weather: city.weather,
        };
        if (cam.zoom < CITY_BITMAP_ZOOM) bitmaps.current.draw(ctx, t, drawable, cam.zoom);
        else drawCity(ctx, t, drawable);
        ctx.globalAlpha = 1;
      }
      roadsUpTo(Infinity);
      drawMinimap();
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const tw = tween.current;
      if (tw) {
        const p = Math.min(1, (now - tw.t0) / 600);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        camera.current = {
          x: tw.from.x + (tw.to.x - tw.from.x) * e,
          y: tw.from.y + (tw.to.y - tw.from.y) * e,
          zoom: tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e,
        };
        dirty.current = true;
        bump();
        if (p >= 1) {
          tween.current = null;
          saveViewport();
        }
      }
      if (!ctx || !tokens.current) return;
      // Nothing on the canvas moves by itself: everything animated is CSS in
      // the layer above. A frame is drawn when something changed or the camera flies.
      if (dirty.current) {
        draw();
        dirty.current = false;
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [toWorld, saveViewport, mapBounds]);

  // Clicking the overview moves the camera there.
  useEffect(() => {
    const mini = minimapRef.current;
    if (!mini) return;
    const onDown = (e: PointerEvent) => {
      const m = minimapMap.current;
      if (!m) return;
      const r = mini.getBoundingClientRect();
      glide({
        x: (e.clientX - r.left - m.ox) / m.scale,
        y: (e.clientY - r.top - m.oy) / m.scale,
        zoom: camera.current.zoom,
      });
    };
    mini.addEventListener('pointerdown', onDown);
    return () => mini.removeEventListener('pointerdown', onDown);
  }, [glide]);

  const hit = useCallback(
    (sx: number, sy: number): Hit => {
      const w = toWorld(sx, sy);
      const { cities: current, roads: currentRoads, districts: currentDistricts, selection: sel } = model.current;
      const ordered = [...current].filter((c) => !c.hidden).sort((a, b) => b.plot.pos.y - a.plot.pos.y);
      for (const city of ordered) {
        const local = { x: w.x - city.plot.pos.x, y: w.y - city.plot.pos.y };
        if (city.task.status !== 'done') {
          const { slots } = cityLayout(city.task.taskNumber);
          for (const site of city.sites) {
            const slot = slots[site.slot];
            if (!slot) continue;
            const c = cellCenter(slot.i, slot.j);
            if (Math.abs(local.x - c.x) < TW * 1.1 && Math.abs(local.y - (c.y - 20)) < 34)
              return { type: 'site', city, site };
          }
        }
        if (
          pointInCity(local) ||
          (Math.abs(local.x) < CITY_HALF_W * 0.6 && local.y < 0 && local.y > -CITY_HALF_H - 70)
        ) {
          return { type: 'city', city };
        }
      }
      const grab = 10 / camera.current.zoom;
      const byNumber = new Map(current.map((c) => [c.task.taskNumber, c]));
      for (const road of currentRoads) {
        const from = byNumber.get(road.from);
        const to = byNumber.get(road.to);
        if (!from || !to) continue;
        const route = roadRoute(from.plot.pos, to.plot.pos);
        for (let i = 1; i < route.length; i++) {
          if (distanceToSegment(w, route[i - 1], route[i]) < grab) return { type: 'road', road };
        }
      }
      for (const district of [...currentDistricts].reverse()) {
        const selected = sel?.type === 'district' && sel.id === district.id;
        const bottom = districtCorners(district)[2];
        if (selected && Math.abs(w.x - bottom.x) < grab && Math.abs(w.y - bottom.y) < grab) {
          return { type: 'districtCorner', district };
        }
        if (pointInDistrict(district, w)) return { type: 'district', district };
      }
      return null;
    },
    [toWorld],
  );

  const cityMenuItems = useCallback(
    (city: CityModel): ContextMenuEntry[] => {
      const task = city.task;
      const store = useProjectStore.getState();
      const map = useCityMapStore.getState();
      const items: ContextMenuEntry[] = [];
      for (const site of city.sites) {
        items.push({
          label: site.label,
          icon: 'terminal',
          onClick: () => {
            select({ type: 'site', taskNumber: task.taskNumber, ptyId: site.ptyId });
            openTerminal(site.ptyId);
          },
        });
      }
      if (city.sites.length) items.push({ separator: true });
      const actions: TaskMenuActions = {
        openTerminal: (provider) => void openTaskShellOnMap(projectPath, task, provider, openTerminal),
        openEditor: () => void openTaskInEditor(projectPath, task),
        openFolder: () => void revealInFileManager(task.worktreePath!),
        setStatus: (status) => transitionTask(projectPath, task, status),
        completeToDone: () => void completeTask({ projectPath, task }),
        archive: () => void archiveTasks(projectPath, [task.taskNumber]),
        remove: () => deleteTasks(projectPath, [task.taskNumber]),
      };
      items.push(openInEntry(input.availableSandboxProviders, !!(task.worktreePath && task.branch), actions));
      items.push(moveToEntry(actions));
      items.push({ separator: true });
      items.push({
        label: 'Road from here…',
        icon: 'arrow-right',
        onClick: () => {
          select({ type: 'city', taskNumber: task.taskNumber });
          setLinking(task.taskNumber);
        },
      });
      const touching = model.current.roads.filter((r) => r.from === task.taskNumber || r.to === task.taskNumber);
      if (touching.length) {
        const byNumber = new Map(model.current.cities.map((c) => [c.task.taskNumber, c]));
        const describe = (road: Road) => {
          const other = road.from === task.taskNumber ? road.to : road.from;
          const name = byNumber.get(other)?.task.name ?? `#${other}`;
          return road.from === task.taskNumber ? `→ #${other} ${name}` : `← #${other} ${name}`;
        };
        items.push({
          label: 'Roads',
          icon: 'git-branch',
          submenu: touching.map((road) => ({
            label: describe(road),
            onClick: () => select({ type: 'road', id: road.id }),
          })),
        });
        items.push({
          label: 'Remove road',
          icon: 'trash',
          submenu: touching.map((road) => ({
            label: describe(road),
            onClick: () => {
              map.removeRoad(projectPath, road.id);
              persistCityMap(projectPath);
            },
          })),
        });
      }
      items.push({ separator: true });
      items.push({
        label: 'Show on board',
        icon: 'kanban',
        onClick: () => store.setKanbanVisible(true),
      });
      return items;
    },
    [projectPath, select, openTerminal, input.availableSandboxProviders],
  );

  const siteMenuItems = useCallback(
    (city: CityModel, site: SiteModel): ContextMenuEntry[] => [
      {
        label: 'Rename',
        icon: 'pencil-simple',
        onClick: () => select({ type: 'site', taskNumber: city.task.taskNumber, ptyId: site.ptyId }),
      },
      { label: 'Close terminal', icon: 'x', danger: true, onClick: () => closeProjectTerminal(site.ptyId) },
    ],
    [select],
  );

  const roadMenuItems = useCallback(
    (road: Road): ContextMenuEntry[] => [
      { label: 'Edit note', icon: 'pencil-simple', onClick: () => select({ type: 'road', id: road.id }) },
      {
        label: 'Remove road',
        icon: 'trash',
        danger: true,
        onClick: () => {
          useCityMapStore.getState().removeRoad(projectPath, road.id);
          persistCityMap(projectPath);
          select(null);
        },
      },
    ],
    [projectPath, select],
  );

  const districtMenuItems = useCallback(
    (district: District): ContextMenuEntry[] => [
      { label: 'Rename', icon: 'pencil-simple', onClick: () => select({ type: 'district', id: district.id }) },
      {
        label: 'Remove district',
        icon: 'trash',
        danger: true,
        onClick: () => {
          useCityMapStore.getState().removeDistrict(projectPath, district.id);
          persistCityMap(projectPath);
          select(null);
        },
      },
    ],
    [projectPath, select],
  );

  const groundMenuItems = useCallback(
    (world: Point): ContextMenuEntry[] => [
      {
        label: 'New district here',
        icon: 'grid-four',
        onClick: () => {
          const district = useCityMapStore.getState().addDistrict(projectPath, snapToCells(world));
          persistCityMap(projectPath);
          select({ type: 'district', id: district.id });
        },
      },
      { label: 'New ticket', icon: 'plus', onClick: () => openTaskComposer() },
      { separator: true },
      { label: 'Fit all', icon: 'arrows-in', onClick: fitAll },
    ],
    [projectPath, select, fitAll],
  );

  const onContextMenu = useCallback(
    (e: { clientX: number; clientY: number; preventDefault(): void }, target: Hit, world?: Point) => {
      e.preventDefault();
      let items: ContextMenuEntry[];
      if (!target) {
        if (!world) return;
        items = groundMenuItems(world);
      } else if (target.type === 'site') items = siteMenuItems(target.city, target.site);
      else if (target.type === 'city') items = cityMenuItems(target.city);
      else if (target.type === 'road') items = roadMenuItems(target.road);
      else items = districtMenuItems(target.district);
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [cityMenuItems, siteMenuItems, roadMenuItems, districtMenuItems, groundMenuItems],
  );

  // Pointer interaction on the canvas: drag a city or district, pan the ground, click to select.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let pointer: {
      x: number;
      y: number;
      sx: number;
      sy: number;
      hit: Hit;
      moved: boolean;
      origin: Point | null;
      size: Point | null;
      inside: number[];
      last: Point;
    } | null = null;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      const h = hit(e.offsetX, e.offsetY);
      const origin =
        h?.type === 'city'
          ? { ...h.city.plot.pos }
          : h?.type === 'district'
            ? { x: h.district.x, y: h.district.y }
            : null;
      pointer = {
        x: e.offsetX,
        y: e.offsetY,
        sx: e.offsetX,
        sy: e.offsetY,
        hit: h,
        moved: false,
        origin,
        size: h?.type === 'districtCorner' ? { x: h.district.w, y: h.district.h } : null,
        inside:
          h?.type === 'district' ? citiesInside(h.district, model.current.cities).map((c) => c.task.taskNumber) : [],
        last: origin ?? { x: 0, y: 0 },
      };
      tween.current = null;
      canvas.style.cursor = h?.type === 'city' || h?.type === 'district' ? 'move' : 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (!pointer) {
        const h = hit(e.offsetX, e.offsetY);
        canvas.style.cursor = h?.type === 'districtCorner' ? 'ns-resize' : h ? 'pointer' : 'grab';
        return;
      }
      const dx = e.offsetX - pointer.x;
      const dy = e.offsetY - pointer.y;
      if (!pointer.moved && Math.hypot(e.offsetX - pointer.sx, e.offsetY - pointer.sy) > 4) pointer.moved = true;
      if (!pointer.moved) return;
      const zoom = camera.current.zoom;
      const total = { x: (e.offsetX - pointer.sx) / zoom, y: (e.offsetY - pointer.sy) / zoom };
      const map = useCityMapStore.getState();
      // From the grab point, not the last event: the model on the hit is a
      // snapshot, so adding each event's delta to it would only ever move
      // one step from where the drag began. Cities and districts land on the
      // cell lattice, so what is dragged together stays in line.
      if (pointer.hit?.type === 'city' && pointer.origin) {
        map.moveCity(
          projectPath,
          pointer.hit.city.task.taskNumber,
          snapToCells({ x: pointer.origin.x + total.x, y: pointer.origin.y + total.y }),
        );
      } else if (pointer.hit?.type === 'district' && pointer.origin) {
        const next = snapToCells({ x: pointer.origin.x + total.x, y: pointer.origin.y + total.y });
        if (next.x !== pointer.last.x || next.y !== pointer.last.y) {
          map.moveDistrict(
            projectPath,
            pointer.hit.district.id,
            { x: next.x - pointer.last.x, y: next.y - pointer.last.y },
            pointer.inside,
          );
          pointer.last = next;
        }
      } else if (pointer.hit?.type === 'districtCorner' && pointer.size) {
        const { s: alongW, t: alongH } = isoDelta(total.x, total.y);
        map.updateDistrict(projectPath, pointer.hit.district.id, {
          w: Math.round((pointer.size.x + alongW) / TW) * TW,
          h: Math.round((pointer.size.y + alongH) / TW) * TW,
        });
      } else {
        focus.current = null;
        camera.current = { ...camera.current, x: camera.current.x - dx / zoom, y: camera.current.y - dy / zoom };
      }
      pointer.x = e.offsetX;
      pointer.y = e.offsetY;
      dirty.current = true;
      bump();
    };
    const up = (e: PointerEvent) => {
      if (!pointer) return;
      if (!pointer.moved) {
        const h = pointer.hit;
        const from = linkingRef.current;
        if (from != null && h?.type === 'city') {
          useCityMapStore.getState().addRoad(projectPath, from, h.city.task.taskNumber);
          persistCityMap(projectPath);
          setLinking(null);
        } else if (from != null && !h) {
          setLinking(null);
        } else if (!h) select(null);
        else if (h.type === 'city') select({ type: 'city', taskNumber: h.city.task.taskNumber });
        else if (h.type === 'site') {
          select({ type: 'site', taskNumber: h.city.task.taskNumber, ptyId: h.site.ptyId });
          openTerminal(h.site.ptyId);
        } else if (h.type === 'road') select({ type: 'road', id: h.road.id });
        else select({ type: 'district', id: h.district.id });
      } else if (pointer.hit) {
        persistCityMap(projectPath);
      } else {
        saveViewport();
      }
      pointer = null;
      canvas.style.cursor = hit(e.offsetX, e.offsetY) ? 'pointer' : 'grab';
    };
    const cancel = () => {
      pointer = null;
      canvas.style.cursor = 'grab';
    };
    const dbl = (e: MouseEvent) => {
      const h = hit(e.offsetX, e.offsetY);
      if (h?.type === 'city' || h?.type === 'site') flyTo(h.city.plot.pos, 1.7);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      tween.current = null;
      const before = toWorld(e.offsetX, e.offsetY);
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.current.zoom * Math.exp(-e.deltaY * 0.0015)));
      camera.current = { ...camera.current, zoom };
      const after = toWorld(e.offsetX, e.offsetY);
      camera.current = {
        ...camera.current,
        x: camera.current.x + before.x - after.x,
        y: camera.current.y + before.y - after.y,
      };
      dirty.current = true;
      bump();
      saveViewport();
    };
    const context = (e: MouseEvent) => onContextMenu(e, hit(e.offsetX, e.offsetY), toWorld(e.offsetX, e.offsetY));

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', context);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('dblclick', dbl);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', context);
    };
  }, [hit, toWorld, select, openTerminal, flyTo, saveViewport, projectPath, onContextMenu]);

  const finishRoad = useCallback(
    (to: number) => {
      const from = linkingRef.current;
      if (from == null) return false;
      useCityMapStore.getState().addRoad(projectPath, from, to);
      persistCityMap(projectPath);
      setLinking(null);
      return true;
    },
    [projectPath],
  );

  // Labels are DOM so they stay legible at any zoom and take real clicks.
  const labels = useMemo(() => {
    const zoom = camera.current.zoom;
    const nodes: React.ReactNode[] = [];
    const selectedTask = selectedTaskNumber(selection);
    const byNumber = new Map(cities.map((c) => [c.task.taskNumber, c]));
    // Cars drive on a CSS motion path in a layer scaled to the map, so they
    // move without a frame of JavaScript; the layer follows the camera.
    const origin = toScreen({ x: 0, y: 0 });
    const cars: React.ReactNode[] = [];
    roads.forEach((road, index) => {
      const from = byNumber.get(road.from);
      const to = byNumber.get(road.to);
      if (!from || !to || from.hidden || to.hidden) return;
      const route = roadRoute(from.plot.pos, to.plot.pos);
      if (route.length < 2) return;
      const { count, durationMs } = carsFor(route);
      const path = route.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      for (let k = 0; k < count; k++) {
        cars.push(
          <span
            key={`${road.id}-${k}`}
            className="city-car"
            data-testid={`city-car-${road.id}`}
            style={{
              offsetPath: `path('${path}')`,
              animationDuration: `${durationMs}ms`,
              animationDelay: `${-Math.round(durationMs * ((k / count + index * 0.37) % 1))}ms`,
              background: CAR_COLOURS[(index + k) % CAR_COLOURS.length],
            }}
          />,
        );
      }
    });
    // Everything that moves on a city is CSS too: the swinging jib and dust of a
    // working site, the halo and smoke of one that needs the user, the weather.
    const fx: React.ReactNode[] = [];
    const near = zoom >= CITY_BITMAP_ZOOM;
    for (const city of cities) {
      if (city.hidden || city.task.status === 'done' || city.task.status === 'todo') continue;
      const { slots } = cityLayout(city.task.taskNumber);
      const base = city.plot.pos;
      for (const site of city.sites) {
        const slot = slots[site.slot];
        if (!slot) continue;
        const c = cellCenter(slot.i, slot.j);
        const x = base.x + c.x;
        const y = base.y + c.y;
        if (site.state === 'working') {
          const top = y - CRANE.mastLift - CRANE.mastHeight;
          fx.push(
            <div
              key={`crane-${site.ptyId}`}
              className="city-fx city-crane-arm"
              data-testid={`city-fx-crane-${site.ptyId}`}
              style={{ left: x, top }}
            >
              <span className="city-crane-jib" />
              <span className="city-crane-hook">
                <span className="city-crane-line" />
                <span className="city-crane-load" style={{ background: slot.wall }} />
              </span>
            </div>,
          );
          if (near) fx.push(<Puffs key={`dust-${site.ptyId}`} x={x - 8} y={y - 2} kind="dust" />);
        } else if (site.state === 'waiting' || site.state === 'error') {
          fx.push(
            <span
              key={`halo-${site.ptyId}`}
              className="city-fx city-halo"
              data-testid={`city-fx-halo-${site.ptyId}`}
              style={{ left: x, top: y, background: SITE_COLOR[site.state] }}
            />,
          );
          if (site.state === 'error' && near)
            fx.push(<Puffs key={`smoke-${site.ptyId}`} x={x - 6} y={y - 4} kind="smoke" />);
        }
      }
      if (city.weather !== 'clear') {
        const rain = city.weather === 'rain';
        const top = base.y - CITY_HALF_H - 62;
        fx.push(
          <span
            key={`cloud-${city.task.taskNumber}`}
            className={`city-fx city-cloud ${rain ? 'city-cloud-rain' : ''}`}
            data-testid={`city-fx-${city.weather}-${city.task.taskNumber}`}
            style={{ left: base.x, top, animationDelay: `${-(city.task.taskNumber * 3700) % 33000}ms` }}
          >
            {rain && near && <span className="city-rain" />}
            {rain && (
              <span
                className="city-lightning"
                style={{ animationDelay: `${-(city.task.taskNumber * 700) % 4200}ms` }}
              />
            )}
          </span>,
        );
        if (!rain) {
          fx.push(
            <span
              key={`cloud2-${city.task.taskNumber}`}
              className="city-fx city-cloud city-cloud-small"
              style={{
                left: base.x - 90,
                top: top + 4,
                animationDelay: `${-(city.task.taskNumber * 3700 + 9000) % 33000}ms`,
              }}
            />,
          );
        }
      }
    }
    nodes.push(
      <div
        key="world"
        className="absolute left-0 top-0"
        style={{ transform: `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        {cars}
        {fx}
      </div>,
    );
    for (const district of districts) {
      const p = toScreen(districtCorners(district)[0]);
      const selected = selection?.type === 'district' && selection.id === district.id;
      const count = citiesInside(district, cities).length;
      nodes.push(
        <button
          key={`district-${district.id}`}
          type="button"
          data-testid={`district-label-${district.id}`}
          className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-full flex items-center gap-2 px-2.5 py-1 rounded-md border text-[11px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap ${selected ? 'border-accent' : 'border-transparent'}`}
          style={{
            left: p.x,
            top: p.y - 6,
            background: 'var(--color-surface-raised)',
            color: districtColor(district.hue, 1, false),
          }}
          onClick={() => select({ type: 'district', id: district.id })}
          onContextMenu={(e) => onContextMenu(e, { type: 'district', district })}
        >
          {district.name}
          <span className="font-mono font-medium normal-case tracking-normal text-text-tertiary">{count}</span>
        </button>,
      );
    }
    for (const road of roads) {
      if (!road.note) continue;
      const from = byNumber.get(road.from);
      const to = byNumber.get(road.to);
      if (!from || !to || from.hidden || to.hidden) continue;
      const route = roadRoute(from.plot.pos, to.plot.pos);
      if (route.length < 2) continue;
      const p = toScreen(routeMidpoint(route));
      const selected = selection?.type === 'road' && selection.id === road.id;
      nodes.push(
        <button
          key={`road-${road.id}`}
          type="button"
          data-testid={`road-label-${road.id}`}
          className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 max-w-[220px] truncate px-2 py-0.5 rounded-md border text-[11px] text-text-primary ${selected ? 'border-accent' : 'border-border'}`}
          style={{ left: p.x, top: p.y - 14, background: 'var(--color-surface-raised)' }}
          title={road.note}
          onClick={() => select({ type: 'road', id: road.id })}
          onContextMenu={(e) => onContextMenu(e, { type: 'road', road })}
        >
          {road.note}
        </button>,
      );
    }
    for (const city of cities) {
      if (city.hidden) continue;
      const top = toScreen({ x: city.plot.pos.x, y: city.plot.pos.y - CITY_HALF_H });
      const selected = selectedTask === city.task.taskNumber;
      const faded = city.task.status === 'done';
      const waiting = city.sites.filter((s) => s.state === 'waiting').length;
      const problems = city.sites.filter((s) => s.state === 'error').length;
      const waitingOn = openSources(city, roads, byNumber);
      const note = latestComment(commentsByTask[city.task.taskNumber] ?? []);
      nodes.push(
        <button
          key={`city-${city.task.taskNumber}`}
          type="button"
          data-testid={`city-label-${city.task.taskNumber}`}
          className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-full flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-lg border text-xs whitespace-nowrap transition-opacity ${selected ? 'border-accent' : 'border-border'} ${faded && !selected ? 'opacity-70' : ''} ${linking != null && linking !== city.task.taskNumber ? 'ring-2 ring-accent/40' : ''} ${flashing[city.task.taskNumber] ? 'city-label-flash' : ''}`}
          style={{
            left: top.x,
            top: top.y - 8,
            background: 'var(--color-surface-raised)',
            boxShadow: 'var(--shadow-panel)',
          }}
          onClick={() => {
            if (!finishRoad(city.task.taskNumber)) select({ type: 'city', taskNumber: city.task.taskNumber });
          }}
          onDoubleClick={() => flyTo(city.plot.pos, 1.7)}
          onContextMenu={(e) => onContextMenu(e, { type: 'city', city })}
        >
          <span
            className="font-mono text-[10px] px-1.5 py-0.5 rounded-md text-text-primary"
            style={{ background: withAlpha(city.color, 0.3) }}
          >
            #{city.task.taskNumber}
          </span>
          <span className="font-medium text-text-primary">{city.task.name}</span>
          {problems > 0 && <AlertBadge count={problems} state="error" />}
          {waiting > 0 && <AlertBadge count={waiting} state="waiting" />}
          {waitingOn.length > 0 && city.task.status !== 'done' && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 h-[18px] rounded-full font-mono text-[10px] text-text-secondary"
              style={{ background: 'color-mix(in srgb, var(--color-ink) 8%, transparent)' }}
              title={`Waits for ${waitingOn.map((c) => `#${c.task.taskNumber} ${c.task.name}`).join(', ')}`}
              data-testid={`city-blocked-${city.task.taskNumber}`}
            >
              <Icon name="arrow-left" className="w-2.5 h-2.5" />
              {waitingOn.length === 1 ? `#${waitingOn[0].task.taskNumber}` : waitingOn.length}
            </span>
          )}
          {note && !faded && (
            <span
              className="inline-flex items-center gap-1 max-w-[180px] truncate text-[11px] text-text-secondary"
              title={note.body}
              data-testid={`city-note-${city.task.taskNumber}`}
            >
              <Icon name="chat-circle" className="w-3 h-3 shrink-0 text-text-tertiary" />
              <span className="truncate">{note.body}</span>
            </span>
          )}
        </button>,
      );
      if (zoom < 0.75 || faded) continue;
      const { slots } = cityLayout(city.task.taskNumber);
      for (const site of city.sites) {
        const slot = slots[site.slot];
        if (!slot) continue;
        const c = cellCenter(slot.i, slot.j);
        const p = toScreen({ x: city.plot.pos.x + c.x, y: city.plot.pos.y + c.y + TH + 2 });
        const sel = selection?.type === 'site' && selection.ptyId === site.ptyId;
        const alert = needsYou(site.state);
        nodes.push(
          <button
            key={`site-${site.ptyId}`}
            type="button"
            data-testid={`site-label-${site.ptyId}`}
            className={`pointer-events-auto absolute -translate-x-1/2 flex items-center gap-1.5 pl-2 pr-2.5 py-0.5 rounded-md border text-[11px] whitespace-nowrap ${sel ? 'border-accent' : alert ? 'border-transparent font-semibold' : 'border-border'}`}
            style={{
              left: p.x,
              top: p.y + 4,
              background: alert ? SITE_COLOR[site.state] : 'var(--color-surface-raised)',
              color: alert ? '#fff' : undefined,
              boxShadow: alert ? `0 0 0 3px ${SITE_RING[site.state]}, var(--shadow-panel)` : undefined,
            }}
            title={SITE_STATE_LABEL[site.state]}
            onClick={() => {
              select({ type: 'site', taskNumber: city.task.taskNumber, ptyId: site.ptyId });
              openTerminal(site.ptyId);
            }}
            onContextMenu={(e) => onContextMenu(e, { type: 'site', city, site })}
          >
            {alert ? (
              <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" />
            ) : (
              <SiteDot state={site.state} />
            )}
            <span className={site.state === 'exited' ? 'text-text-tertiary' : alert ? '' : 'text-text-primary'}>
              {site.label}
            </span>
            {alert && <span className="opacity-90">· {SITE_STATE_LABEL[site.state]}</span>}
          </button>,
        );
      }
    }
    return nodes;
    // `bump` re-runs this on every camera change through the reducer state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cities,
    roads,
    districts,
    selection,
    linking,
    flashing,
    commentsByTask,
    toScreen,
    select,
    openTerminal,
    flyTo,
    onContextMenu,
    finishRoad,
    camera.current.x,
    camera.current.y,
    camera.current.zoom,
    size.current.w,
    size.current.h,
  ]);

  return {
    canvasRef,
    groundRef,
    containerRef,
    probeRef,
    minimapRef,
    labels,
    flyTo,
    fitAll,
    onContextMenu,
    menu,
    closeMenu: () => setMenu(null),
    linking,
    cancelLinking: () => setLinking(null),
    night,
  };
}

/** Opens a shell in the task's worktree and shows it in the drawer once it is registered. */
async function openTaskShellOnMap(
  projectPath: string,
  task: TaskWithWorkspace,
  sandboxProvider: SandboxProviderId | undefined,
  openTerminal: (ptyId: string | null) => void,
): Promise<void> {
  const before = new Set(useTerminalStore.getState().terminalsByProject[projectPath] ?? []);
  const opened = await openTaskShell(projectPath, task, { mode: 'resume', sandboxProvider });
  if (!opened) return;
  const store = useTerminalStore.getState();
  const fresh = (store.terminalsByProject[projectPath] ?? []).find(
    (id) => !before.has(id) && store.displayStates[id]?.taskId === task.taskNumber,
  );
  useCityMapStore.getState().setSelection(projectPath, { type: 'city', taskNumber: task.taskNumber });
  if (fresh) openTerminal(fresh);
}

// ── Pieces ──────────────────────────────────────────────────────────

const SITE_COLOR: Record<SiteState, string> = {
  working: 'var(--color-status-thinking)',
  waiting: 'var(--color-ansi-yellow)',
  error: 'var(--color-error)',
  done: 'var(--color-success)',
  exited: 'var(--color-text-tertiary)',
};
const SITE_RING: Record<SiteState, string> = {
  working: 'transparent',
  waiting: 'color-mix(in srgb, var(--color-ansi-yellow) 35%, transparent)',
  error: 'color-mix(in srgb, var(--color-error) 35%, transparent)',
  done: 'transparent',
  exited: 'transparent',
};

function SiteDot({ state, className = '' }: { state: SiteState; className?: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${className}`}
      style={{ background: SITE_COLOR[state] }}
    />
  );
}

/** Three puffs rising and thinning in turn: dust off a site at work, smoke off one with a problem. */
function Puffs({ x, y, kind }: { x: number; y: number; kind: 'dust' | 'smoke' }) {
  return (
    <span className="city-fx" style={{ left: x, top: y }} data-testid={`city-fx-${kind}`}>
      {[0, 1, 2].map((k) => (
        <span
          key={k}
          className={`city-puff city-puff-${kind}`}
          style={{ left: k * 5, animationDelay: `${-k * 500}ms` }}
        />
      ))}
    </span>
  );
}

function AlertBadge({ count, state }: { count: number; state: 'waiting' | 'error' }) {
  return (
    <span
      className="city-alert inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full font-mono text-[10px] font-semibold text-white"
      style={{ background: SITE_COLOR[state] }}
      title={state === 'waiting' ? `${count} waiting for you` : `${count} with a problem`}
      data-testid={`city-alert-${state}`}
    >
      {count}
    </span>
  );
}

interface CitySidebarProps {
  projectPath: string;
  width: number;
  cities: CityModel[];
  districts: District[];
  group: CityMapSidebarGroup;
  selection: CityMapSelection | null;
  looseTerminals: number;
  tagFilter: string | null;
  onPick: (city: CityModel) => void;
  onPickSite: (city: CityModel, site: SiteModel) => void;
  onPickDistrict: (district: District) => void;
}

function CitySidebar({
  projectPath,
  width,
  cities,
  districts,
  group,
  selection,
  looseTerminals,
  tagFilter,
  onPick,
  onPickSite,
  onPickDistrict,
}: CitySidebarProps) {
  const shown = cities.filter((c) => !c.hidden);
  const waiting: { city: CityModel; site: SiteModel }[] = [];
  const problems: { city: CityModel; site: SiteModel }[] = [];
  let working = 0;
  for (const city of shown) {
    if (city.task.status === 'done') continue;
    for (const site of city.sites) {
      if (site.state === 'waiting') waiting.push({ city, site });
      else if (site.state === 'error') problems.push({ city, site });
      else if (site.state === 'working') working++;
    }
  }
  const cursor = useRef(0);
  const jump = (list: { city: CityModel; site: SiteModel }[]) => {
    if (!list.length) return;
    const { city, site } = list[cursor.current++ % list.length];
    onPickSite(city, site);
  };
  const selectedTask = selectedTaskNumber(selection);
  const byStatus = (a: CityModel, b: CityModel) =>
    STATUS_ORDER.indexOf(a.task.status) - STATUS_ORDER.indexOf(b.task.status) || b.task.taskNumber - a.task.taskNumber;

  const sections: { key: string; title: React.ReactNode; cities: CityModel[]; onTitle?: () => void }[] = [];
  if (group === 'status') {
    for (const status of STATUS_ORDER) {
      sections.push({
        key: status,
        title: STATUS_LABELS[status],
        cities: shown.filter((c) => c.task.status === status).sort((a, b) => b.task.taskNumber - a.task.taskNumber),
      });
    }
  } else {
    const placed = new Set<number>();
    for (const district of [...districts].sort((a, b) => a.name.localeCompare(b.name))) {
      const inside = citiesInside(district, shown).sort(byStatus);
      for (const c of inside) placed.add(c.task.taskNumber);
      sections.push({
        key: district.id,
        title: (
          <>
            <span className="w-2 h-2 rounded-[2px]" style={{ background: districtColor(district.hue, 1, false) }} />
            {district.name}
          </>
        ),
        cities: inside,
        onTitle: () => onPickDistrict(district),
      });
    }
    sections.push({
      key: 'none',
      title: 'No district',
      cities: shown.filter((c) => !placed.has(c.task.taskNumber)).sort(byStatus),
    });
  }

  return (
    <aside
      className="shrink-0 flex flex-col overflow-y-auto"
      style={{ width, background: 'var(--color-background-secondary)' }}
      aria-label="Cities"
    >
      <div
        className="m-3 mb-1 p-2.5 rounded-[10px] border border-border flex flex-col gap-1.5"
        style={{ background: 'var(--color-surface-raised)' }}
      >
        <AttentionRow
          count={waiting.length}
          label="waiting for you"
          color={SITE_COLOR.waiting}
          onNext={() => jump(waiting)}
        />
        <AttentionRow
          count={problems.length}
          label="hit a problem"
          color={SITE_COLOR.error}
          onNext={() => jump(problems)}
        />
        <AttentionRow count={working} label="agents working" color="var(--color-text-tertiary)" />
      </div>
      <div className="px-3 py-2 flex items-center gap-2">
        <button type="button" className="btn-secondary flex-1 text-xs" onClick={() => openTaskComposer()}>
          + New ticket
        </button>
        <div
          className="flex rounded-md border border-border overflow-hidden text-[11px]"
          role="radiogroup"
          aria-label="Group cities by"
        >
          {(['status', 'district'] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={group === g}
              data-testid={`sidebar-group-${g}`}
              className={`px-2 py-1 ${group === g ? 'bg-ink/[0.08] text-text-primary' : 'text-text-tertiary hover:text-text-primary'}`}
              onClick={() => useUIStore.getState().setCityMapSidebarGroup(g)}
            >
              {g === 'status' ? 'Status' : 'District'}
            </button>
          ))}
        </div>
      </div>
      {tagFilter && shown.length < cities.length && (
        <div className="mx-3 mb-1 text-[11px] text-text-tertiary">
          {cities.length - shown.length} cit{cities.length - shown.length === 1 ? 'y' : 'ies'} hidden by the tag filter.
        </div>
      )}
      {sections.map((section) => (
        <div key={section.key} className="px-2 pt-2 pb-1">
          <h3 className="mx-2 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary flex items-center gap-2">
            {section.onTitle ? (
              <button
                type="button"
                className="flex items-center gap-2 hover:text-text-primary"
                onClick={section.onTitle}
              >
                {section.title}
              </button>
            ) : (
              section.title
            )}
            <span className="font-mono font-medium">{section.cities.length}</span>
          </h3>
          {section.cities.length === 0 && <div className="mx-2 mb-1 text-xs text-text-tertiary">Nothing here</div>}
          {section.cities.map((city) => {
            const status = city.task.status;
            const selected = selectedTask === city.task.taskNumber;
            const openPty = selection?.type === 'site' && selected ? selection.ptyId : null;
            return (
              <div key={city.task.taskNumber}>
                <button
                  type="button"
                  data-testid={`city-row-${city.task.taskNumber}`}
                  className={`w-full text-left grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-1.5 rounded-lg border text-xs hover:bg-ink/[0.04] ${selected ? 'border-border bg-ink/[0.04]' : 'border-transparent'}`}
                  onClick={() => onPick(city)}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-[3px] rotate-45 scale-[0.85]"
                    style={{
                      background: status === 'todo' ? 'transparent' : city.color,
                      border: `1.5px ${status === 'todo' ? 'dashed' : 'solid'} ${city.color}`,
                    }}
                  />
                  <span
                    className={`truncate font-medium ${status === 'done' ? 'text-text-secondary' : 'text-text-primary'}`}
                  >
                    {city.task.name}
                    <span className="ml-1.5 font-mono text-[10px] text-text-tertiary">#{city.task.taskNumber}</span>
                  </span>
                  {city.sites.length > 0 && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 h-[18px] rounded-full font-mono text-[10px] text-text-secondary"
                      style={{ background: 'color-mix(in srgb, var(--color-ink) 8%, transparent)' }}
                      data-testid={`city-count-${city.task.taskNumber}`}
                      title={`${city.sites.length} terminal${city.sites.length === 1 ? '' : 's'}`}
                    >
                      <Icon name="terminal" className="w-2.5 h-2.5" />
                      {city.sites.length}
                    </span>
                  )}
                </button>
                {selected && city.sites.length > 0 && (
                  <div className="ml-4 mb-1 border-l border-border pl-1.5 flex flex-col">
                    {city.sites.map((site) => (
                      <button
                        key={site.ptyId}
                        type="button"
                        data-testid={`sidebar-site-${site.ptyId}`}
                        className={`w-full text-left grid grid-cols-[10px_minmax(0,1fr)] items-center gap-2 px-2 py-1 rounded-md text-[11px] hover:bg-ink/[0.04] ${openPty === site.ptyId ? 'bg-ink/[0.06] text-text-primary' : 'text-text-secondary'}`}
                        title={SITE_STATE_LABEL[site.state]}
                        onClick={() => onPickSite(city, site)}
                      >
                        <SiteDot state={site.state} className="!w-2 !h-2" />
                        <span className="truncate">{site.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <SidebarArchive projectPath={projectPath} />
      {looseTerminals > 0 && (
        <div className="px-4 py-3 text-[11px] text-text-tertiary border-t border-border">
          {looseTerminals} terminal{looseTerminals > 1 ? 's' : ''} outside any ticket.{' '}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => useProjectStore.getState().setTerminalLayout('stack')}
          >
            Show stack
          </button>
        </div>
      )}
    </aside>
  );
}

/** Archived tickets have no city on the map; the list is the only way back. */
function SidebarArchive({ projectPath }: { projectPath: string }) {
  const count = useProjectStore((s) => s.archivedTasks.length);
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="mt-auto px-2 pt-2 pb-1 border-t border-border">
      <button
        type="button"
        className="mx-2 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary hover:text-text-primary flex items-center gap-2"
        aria-expanded={open}
        data-testid="sidebar-archive-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        Archive
        <span className="font-mono font-medium">{count}</span>
      </button>
      {open && <ArchivedTaskList projectPath={projectPath} />}
    </div>
  );
}

function AttentionRow({
  count,
  label,
  color,
  onNext,
}: {
  count: number;
  label: string;
  color: string;
  onNext?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="font-mono text-lg font-semibold leading-none min-w-6"
        style={{ color: count ? color : 'var(--color-text-tertiary)' }}
      >
        {count}
      </span>
      <span className="flex-1 text-[11px] text-text-secondary">{label}</span>
      {count > 0 && onNext && (
        <button
          type="button"
          className="px-2 py-0.5 text-[11px] rounded-md border border-border text-text-secondary hover:text-text-primary"
          onClick={onNext}
        >
          Next
        </button>
      )}
    </div>
  );
}

const PANEL_STYLE: CSSProperties = { background: 'var(--color-surface-raised)', boxShadow: 'var(--shadow-panel)' };
const PANEL_CLASS =
  'absolute top-3 right-3 w-80 rounded-[14px] border border-bezel-panel glass-bevel flex flex-col z-20';
/** `w-80` plus `right-3`: how much of the map an open inspector hides. */
const INSPECTOR_COVER = 320 + 12;
const NAME_INPUT_CLASS =
  'w-full bg-transparent border border-transparent hover:border-border focus:border-accent rounded-md px-1.5 -mx-1.5 py-0.5 text-base font-semibold text-text-primary outline-none';
const EYEBROW_CLASS =
  'flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary';

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-text-tertiary hover:text-text-primary"
      onClick={onClick}
      aria-label="Close inspector"
    >
      <Icon name="x" className="w-3.5 h-3.5" />
    </button>
  );
}

function CityLink({ city, onPick }: { city: CityModel; onPick: (city: CityModel) => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs hover:bg-ink/[0.04] min-w-0"
      onClick={() => onPick(city)}
    >
      <span className="w-2 h-2 rounded-[2px] rotate-45 shrink-0" style={{ background: city.color }} />
      <span className="truncate text-text-primary">{city.task.name}</span>
      <span className="font-mono text-[10px] text-text-tertiary">#{city.task.taskNumber}</span>
    </button>
  );
}

interface CityInspectorProps {
  projectPath: string;
  city: CityModel;
  site?: SiteModel;
  district?: District;
  waitingOn: CityModel[];
  onClose: () => void;
  onSelectSite: (site: SiteModel) => void;
  onBackToCity: () => void;
  onOpenTerminal: (ptyId: string | null) => void;
  onPickCity: (city: CityModel) => void;
  onContextMenu: (e: React.MouseEvent, target: Hit) => void;
}

function CityInspector({
  projectPath,
  city,
  site,
  district,
  waitingOn,
  onClose,
  onSelectSite,
  onBackToCity,
  onOpenTerminal,
  onPickCity,
  onContextMenu,
}: CityInspectorProps) {
  const task = city.task;
  const [name, setName] = useState(task.name);
  useEffect(() => setName(task.name), [task.name]);

  const commitName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === task.name) {
      setName(task.name);
      return;
    }
    await window.api.task.setName(projectPath, task.taskNumber, trimmed);
    useProjectStore.getState().loadTasks(projectPath);
  };
  const setStatus = (status: TaskStatus) => transitionTask(projectPath, task, status);

  if (site) {
    return (
      <SiteInspector
        city={city}
        site={site}
        onClose={onClose}
        onBack={onBackToCity}
        onFocus={() => onOpenTerminal(site.ptyId)}
      />
    );
  }

  return (
    <div className={`${PANEL_CLASS} bottom-3 overflow-y-auto`} style={PANEL_STYLE} data-testid="city-inspector">
      <div className="p-4 pb-3 border-b border-border flex flex-col gap-2">
        <div className={EYEBROW_CLASS}>
          <span className="w-2.5 h-2.5 rounded-[3px] rotate-45 scale-[0.85]" style={{ background: city.color }} />
          <span>City</span>
          <span className="font-mono normal-case tracking-normal text-text-secondary">#{task.taskNumber}</span>
          {district && (
            <span
              className="normal-case tracking-normal truncate"
              style={{ color: districtColor(district.hue, 1, false) }}
            >
              · {district.name}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="text-text-tertiary hover:text-text-primary"
            aria-label="More"
            onClick={(e) => onContextMenu(e, { type: 'city', city })}
          >
            <Icon name="dots-six-vertical" className="w-3.5 h-3.5" />
          </button>
          <CloseButton onClick={onClose} />
        </div>
        <input
          className={NAME_INPUT_CLASS}
          value={name}
          aria-label="Ticket name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setName(task.name);
          }}
        />
        <select
          className="text-xs bg-transparent border border-border rounded-md px-2 py-1 text-text-primary outline-none focus:border-accent"
          value={task.status}
          aria-label="Status"
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      {waitingOn.length > 0 && task.status !== 'done' && (
        <div className="p-4 border-b border-border flex flex-col gap-1">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-1">Waits for</h4>
          {waitingOn.map((c) => (
            <CityLink key={c.task.taskNumber} city={c} onPick={onPickCity} />
          ))}
        </div>
      )}
      <p className="px-4 py-2 border-b border-border text-[11px] text-text-tertiary" data-testid="city-climate">
        {BIOME_LABEL[city.style.biome]} · {CULTURE_LABEL[city.style.culture]} · {SEASON_LABEL[city.season]}
        {city.weather !== 'clear' && ` · ${WEATHER_LABEL[city.weather]}`}
      </p>
      <div className="p-4 border-b border-border">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2">Description</h4>
        {task.prompt ? (
          <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed">{task.prompt}</p>
        ) : (
          <p className="text-xs text-text-tertiary italic">No description yet. Add one on the board.</p>
        )}
      </div>
      <CityComments projectPath={projectPath} taskNumber={task.taskNumber} />
      <div className="p-4 border-b border-border flex flex-col gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary flex items-center">
          Sites
          <span className="flex-1" />
          <button
            type="button"
            className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline"
            onClick={() => void openTaskShellOnMap(projectPath, task, undefined, onOpenTerminal)}
          >
            + New terminal
          </button>
        </h4>
        {city.sites.length === 0 && (
          <p className="text-[11px] text-text-tertiary leading-snug">
            No open terminals. A new one becomes a construction site on a free lot; when it finishes and closes, the
            building stays.
          </p>
        )}
        {city.sites.map((s) => (
          <button
            key={s.ptyId}
            type="button"
            data-testid={`site-row-${s.ptyId}`}
            className="grid grid-cols-[10px_minmax(0,1fr)] items-center gap-2.5 px-2.5 py-2 rounded-[10px] border border-border text-left hover:bg-ink/[0.04]"
            onClick={() => onSelectSite(s)}
            onContextMenu={(e) => onContextMenu(e, { type: 'site', city, site: s })}
          >
            <SiteDot state={s.state} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-text-primary">{s.label}</span>
              <span className="block text-[11px] text-text-tertiary">{SITE_STATE_LABEL[s.state]}</span>
            </span>
          </button>
        ))}
        {city.plot.built.length > 0 && (
          <p className="text-[11px] text-text-tertiary">
            {city.plot.built.length} finished session{city.plot.built.length > 1 ? 's' : ''} left buildings behind.
          </p>
        )}
      </div>
      <div className="p-4 flex flex-wrap gap-2 mt-auto">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => void openTaskInEditor(projectPath, task)}
        >
          Open in editor
        </button>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => useProjectStore.getState().setKanbanVisible(true)}
        >
          Show on board
        </button>
      </div>
    </div>
  );
}

function CityComments({ projectPath, taskNumber }: { projectPath: string; taskNumber: number }) {
  const count = useTaskCommentStore(selectTaskComments(taskNumber)).length;
  return (
    <div className="p-4 border-b border-border">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2 flex items-center gap-2">
        Comments
        {count > 0 && <span className="font-mono font-medium">{count}</span>}
      </h4>
      <TaskComments projectPath={projectPath} taskNumber={taskNumber} />
    </div>
  );
}

function SiteInspector({
  city,
  site,
  onClose,
  onBack,
  onFocus,
}: {
  city: CityModel;
  site: SiteModel;
  onClose: () => void;
  onBack: () => void;
  onFocus: () => void;
}) {
  const [label, setLabel] = useState(site.display.label || site.display.lastOscTitle);
  useEffect(
    () => setLabel(site.display.label || site.display.lastOscTitle),
    [site.display.label, site.display.lastOscTitle],
  );
  const commit = () => {
    const trimmed = label.trim();
    if (trimmed !== site.display.label) renameTerminal(site.ptyId, trimmed);
  };
  return (
    <div className={`${PANEL_CLASS} overflow-hidden`} style={PANEL_STYLE} data-testid="site-inspector">
      <div className="p-4 pb-3 border-b border-border flex flex-col gap-2">
        <div className={EYEBROW_CLASS}>
          <span>Site</span>
          <button
            type="button"
            className="normal-case tracking-normal font-medium text-text-secondary hover:text-text-primary truncate"
            onClick={onBack}
          >
            in #{city.task.taskNumber} {city.task.name}
          </button>
          <span className="flex-1" />
          <CloseButton onClick={onClose} />
        </div>
        <input
          className={NAME_INPUT_CLASS}
          value={label}
          placeholder={site.display.lastOscTitle || 'Shell'}
          aria-label="Site name"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <p className="text-[11px] text-text-tertiary leading-snug">
          Named from the session title the agent reports. A name you type here stays.
        </p>
      </div>
      <div className="p-4 flex items-center gap-2">
        <SiteDot state={site.state} />
        <span className="text-xs text-text-primary">{SITE_STATE_LABEL[site.state]}</span>
        <span className="flex-1" />
        <button type="button" className="btn-secondary text-xs" onClick={onFocus}>
          Focus terminal
        </button>
        <button type="button" className="btn-secondary text-xs" onClick={() => closeProjectTerminal(site.ptyId)}>
          Close
        </button>
      </div>
    </div>
  );
}

function RoadInspector({
  projectPath,
  road,
  from,
  to,
  onClose,
  onPickCity,
}: {
  projectPath: string;
  road: Road;
  from?: CityModel;
  to?: CityModel;
  onClose: () => void;
  onPickCity: (city: CityModel) => void;
}) {
  const [note, setNote] = useState(road.note ?? '');
  useEffect(() => setNote(road.note ?? ''), [road.id, road.note]);
  const commit = () => {
    const trimmed = note.trim();
    if (trimmed === (road.note ?? '')) return;
    useCityMapStore.getState().updateRoad(projectPath, road.id, { note: trimmed || undefined });
    persistCityMap(projectPath);
  };
  const open = from && from.task.status !== 'done';
  return (
    <div className={`${PANEL_CLASS} overflow-hidden`} style={PANEL_STYLE} data-testid="road-inspector">
      <div className="p-4 pb-3 border-b border-border flex flex-col gap-2">
        <div className={EYEBROW_CLASS}>
          <Icon name="arrow-right" className="w-3 h-3" />
          <span>Road</span>
          <span className="flex-1" />
          <CloseButton onClick={onClose} />
        </div>
        <div className="flex flex-col gap-0.5 -mx-2">
          {from && <CityLink city={from} onPick={onPickCity} />}
          <span className="px-2 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">leads to</span>
          {to && <CityLink city={to} onPick={onPickCity} />}
        </div>
        <p className="text-[11px] text-text-tertiary leading-snug">
          {open && from
            ? `#${to?.task.taskNumber} waits: #${from.task.taskNumber} is ${STATUS_LABELS[from.task.status].toLowerCase()}.`
            : 'The road is clear: what it leads from is done.'}
        </p>
      </div>
      <div className="p-4 flex flex-col gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary" htmlFor="road-note">
          Note
        </label>
        <textarea
          id="road-note"
          className="w-full min-h-[64px] px-2.5 py-2 text-xs leading-snug text-text-primary bg-background border border-border rounded-md outline-none resize-y focus:border-accent placeholder:text-text-tertiary"
          placeholder="Why one waits for the other, e.g. blocked until the PR is merged"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              useCityMapStore.getState().removeRoad(projectPath, road.id);
              persistCityMap(projectPath);
              onClose();
            }}
          >
            Remove road
          </button>
        </div>
      </div>
    </div>
  );
}

function DistrictInspector({
  projectPath,
  district,
  cities,
  onClose,
  onPickCity,
}: {
  projectPath: string;
  district: District;
  cities: CityModel[];
  onClose: () => void;
  onPickCity: (city: CityModel) => void;
}) {
  const [name, setName] = useState(district.name);
  useEffect(() => setName(district.name), [district.name]);
  const update = (patch: Partial<Omit<District, 'id'>>) => {
    useCityMapStore.getState().updateDistrict(projectPath, district.id, patch);
    persistCityMap(projectPath);
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(district.name);
      return;
    }
    if (trimmed !== district.name) update({ name: trimmed });
  };
  return (
    <div className={`${PANEL_CLASS} overflow-hidden`} style={PANEL_STYLE} data-testid="district-inspector">
      <div className="p-4 pb-3 border-b border-border flex flex-col gap-2">
        <div className={EYEBROW_CLASS}>
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: districtColor(district.hue, 1, false) }} />
          <span>District</span>
          <span className="flex-1" />
          <CloseButton onClick={onClose} />
        </div>
        <input
          className={NAME_INPUT_CLASS}
          value={name}
          aria-label="District name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setName(district.name);
          }}
        />
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="District landscape">
          {DISTRICT_TERRAINS.map((terrain) => (
            <button
              key={terrain}
              type="button"
              role="radio"
              aria-checked={district.terrain === terrain}
              data-testid={`district-terrain-${terrain}`}
              className={`flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full border text-[11px] ${
                district.terrain === terrain
                  ? 'border-ink text-text-primary'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => update({ terrain, hue: DISTRICT_TERRAIN_HUE[terrain] })}
            >
              <span
                className="w-3 h-3 rounded-full"
                style={{ background: districtColor(DISTRICT_TERRAIN_HUE[terrain], 0.85, false) }}
              />
              {DISTRICT_TERRAIN_LABEL[terrain]}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-tertiary leading-snug">
          Drag the district to move it with its cities; drag its bottom corner to resize it.
        </p>
      </div>
      <div className="p-4 flex flex-col gap-1.5 max-h-64 overflow-y-auto">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
          Cities inside <span className="font-mono font-medium">{cities.length}</span>
        </h4>
        {cities.length === 0 && <p className="text-[11px] text-text-tertiary">Drag cities in to assign them.</p>}
        {cities.map((city) => (
          <CityLink key={city.task.taskNumber} city={city} onPick={onPickCity} />
        ))}
      </div>
      <div className="p-4 pt-0 flex gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => {
            useCityMapStore.getState().removeDistrict(projectPath, district.id);
            persistCityMap(projectPath);
            onClose();
          }}
        >
          Remove district
        </button>
      </div>
    </div>
  );
}

function TerminalDrawer({
  ptyId,
  projectPath,
  width,
  onHide,
}: {
  ptyId: string;
  projectPath: string;
  width: number;
  onHide: () => void;
}) {
  // The glass bevel forces its direct children into normal flow, so the
  // handle hangs off a plain wrapper and the bevelled box sits beside it.
  return (
    <div
      className="absolute top-3 right-3 bottom-3 max-w-[calc(100%-24px)] z-30"
      style={{ width }}
      data-testid="terminal-drawer"
    >
      <div className="absolute inset-y-0 -left-px z-10 flex">
        <ResizeHandle
          width={width}
          onWidth={(next) => useUIStore.getState().setCityMapDrawerWidth(next)}
          min={CITY_MAP_DRAWER_MIN_WIDTH}
          max={CITY_MAP_DRAWER_MAX_WIDTH}
          defaultWidth={CITY_MAP_DRAWER_DEFAULT_WIDTH}
          label="Resize the terminal"
          edge="start"
        />
      </div>
      <div
        className="h-full rounded-[14px] border border-bezel-panel glass-bevel overflow-hidden flex flex-col"
        style={{ background: 'var(--color-terminal-bg)', boxShadow: 'var(--shadow-panel)' }}
      >
        <div className="flex items-stretch shrink-0">
          <button
            type="button"
            className="px-2 border-r border-border text-text-tertiary hover:text-text-primary"
            onClick={onHide}
            aria-label="Hide terminal"
            title="Back to the map"
          >
            <Icon name="caret-right" className="w-3.5 h-3.5" />
          </button>
          <div className="flex-1 min-w-0">
            <TerminalHeader ptyId={ptyId} isActive onClose={() => closeProjectTerminal(ptyId)} />
          </div>
        </div>
        <div className="flex flex-col flex-1 min-h-0">
          <TerminalBody ptyId={ptyId} projectPath={projectPath} />
        </div>
      </div>
    </div>
  );
}
