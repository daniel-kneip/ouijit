import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  useUIStore,
  CITY_MAP_SIDEBAR_DEFAULT_WIDTH,
  CITY_MAP_SIDEBAR_MAX_WIDTH,
  CITY_MAP_SIDEBAR_MIN_WIDTH,
  CITY_MAP_DRAWER_DEFAULT_WIDTH,
  CITY_MAP_DRAWER_MAX_WIDTH,
  CITY_MAP_DRAWER_MIN_WIDTH,
} from '../../stores/uiStore';
import { ResizeHandle } from '../common/ResizeHandle';
import type { TerminalDisplayState } from '../../stores/terminalDisplay';
import {
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
import { revealInFileManager } from '../../utils/fileManager';
import { openTaskComposer } from '../../utils/openTaskComposer';
import {
  CITY_HALF_H,
  CITY_HALF_W,
  SITE_STATE_LABEL,
  TH,
  TW,
  cellCenter,
  cityLayout,
  cityPresence,
  pointInCity,
  siteState,
  type Point,
  type SiteState,
} from './cityGeometry';
import {
  districtColor,
  drawCity,
  drawDistrict,
  drawGrid,
  drawPath,
  drawRoad,
  drawSelectionRing,
  drawTerrain,
  withAlpha,
  type DrawCity,
  type MapTokens,
} from './drawCity';

const EMPTY_IDS: string[] = [];
const EMPTY_ROADS: Road[] = [];
const EMPTY_DISTRICTS: District[] = [];
const STATUS_ORDER: TaskStatus[] = ['in_progress', 'in_review', 'todo', 'done'];
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.6;
const DISTRICT_HUES = [210, 28, 150, 330, 90, 260, 45, 190];

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
}

const TOKEN_SOURCES: Record<Exclude<keyof MapTokens, 'night'>, string> = {
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
    tokens[key as Exclude<keyof MapTokens, 'night'>] = read(css);
  }
  const bg = read('var(--color-background)')
    .match(/\d+(\.\d+)?/g)
    ?.map(Number) ?? [255, 255, 255];
  tokens.night = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255 < 0.5;
  return tokens;
}

function siteLabel(display: TerminalDisplayState): string {
  return display.label || display.lastOscTitle || 'Shell';
}

function selectedTaskNumber(selection: CityMapSelection | null): number | null {
  return selection && selection.type !== 'district' ? selection.taskNumber : null;
}

function citiesInside(district: District, cities: readonly CityModel[]): CityModel[] {
  return cities.filter((c) => pointInDistrict(district, c.plot.pos));
}

interface CityMapProps {
  projectPath: string;
}

export function CityMap({ projectPath }: CityMapProps) {
  const tasks = useProjectStore((s) => s.tasks);
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
      result.push({ task, plot, color, sites });
    }
    return result;
  }, [mapState, tasks, chainMap, displayStates]);
  const roads = mapState?.roads ?? EMPTY_ROADS;
  const districts = mapState?.districts ?? EMPTY_DISTRICTS;

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

  const surface = useMapSurface({
    projectPath,
    ready,
    cities,
    roads,
    districts,
    selection,
    viewport: mapState?.viewport,
    select,
    openTerminal,
    availableSandboxProviders,
  });
  const { canvasRef, containerRef, probeRef, labels, flyTo, onContextMenu, menu, closeMenu, linking, cancelLinking } =
    surface;

  const taskNumber = selectedTaskNumber(selection);
  const selectedCity = taskNumber != null ? cities.find((c) => c.task.taskNumber === taskNumber) : undefined;
  const selectedSite =
    selection?.type === 'site' && selectedCity
      ? selectedCity.sites.find((s) => s.ptyId === selection.ptyId)
      : undefined;
  const selectedDistrict = selection?.type === 'district' ? districts.find((d) => d.id === selection.id) : undefined;
  const linkingCity = linking != null ? cities.find((c) => c.task.taskNumber === linking) : undefined;

  const sidebarWidth = useUIStore((s) => s.cityMapSidebarWidth);
  const drawerWidth = useUIStore((s) => s.cityMapDrawerWidth);

  return (
    <div
      className="flex h-full min-h-0 transition-[margin-left] duration-200 ease-out"
      style={{ marginLeft: 'var(--sidebar-offset, 0px)' }}
      data-testid="city-map"
    >
      <CitySidebar
        width={sidebarWidth}
        cities={cities}
        selection={selection}
        looseTerminals={looseTerminals}
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
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full block touch-none"
          aria-label="Map of tasks as cities"
        />
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
        {selectedCity && (
          <CityInspector
            projectPath={projectPath}
            city={selectedCity}
            site={selectedSite}
            district={districts.find((d) => pointInDistrict(d, selectedCity.plot.pos))}
            onClose={() => select(null)}
            onSelectSite={(site) => {
              select({ type: 'site', taskNumber: selectedCity.task.taskNumber, ptyId: site.ptyId });
              openTerminal(site.ptyId);
            }}
            onBackToCity={() => select({ type: 'city', taskNumber: selectedCity.task.taskNumber })}
            onOpenTerminal={openTerminal}
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
        {openPtyId && displayStates[openPtyId] && (
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
  viewport: CityMapViewport | undefined;
  select: (s: CityMapSelection | null) => void;
  openTerminal: (ptyId: string | null) => void;
  availableSandboxProviders: SandboxProviderId[];
}

type Hit =
  | { type: 'city'; city: CityModel }
  | { type: 'site'; city: CityModel; site: SiteModel }
  | { type: 'district'; district: District }
  | { type: 'districtCorner'; district: District }
  | null;

function useMapSurface(input: MapSurfaceInput) {
  const { projectPath, ready, cities, roads, districts, selection, viewport, select, openTerminal } = input;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const camera = useRef<CityMapViewport>({ x: 0, y: 0, zoom: 0.9 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const tokens = useRef<MapTokens | null>(null);
  const dirty = useRef(true);
  const tween = useRef<{ from: CityMapViewport; to: CityMapViewport; t0: number } | null>(null);
  const model = useRef({ cities, roads, districts, selection });
  model.current = { cities, roads, districts, selection };
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
    if (probeRef.current) tokens.current = resolveTokens(probeRef.current);
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

  const flyTo = useCallback(
    (target: Point, zoom: number) => {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const to = {
        x: target.x,
        y: target.y + 10,
        zoom: zoom > 0 ? Math.max(camera.current.zoom, zoom) : camera.current.zoom,
      };
      if (reduced) {
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

  // Resize + draw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');

    const resize = () => {
      const r = container.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      dirty.current = true;
      bump();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    let frame = 0;
    const draw = (time: number) => {
      const t = tokens.current;
      const { w, h, dpr } = size.current;
      const cam = camera.current;
      const animate = !reduced.matches;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = t.ground;
      ctx.fillRect(0, 0, w, h);
      const tl = toWorld(0, 0);
      const br = toWorld(w, h);
      const visible = { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
      ctx.setTransform(
        dpr * cam.zoom,
        0,
        0,
        dpr * cam.zoom,
        dpr * (w / 2 - cam.x * cam.zoom),
        dpr * (h / 2 - cam.y * cam.zoom),
      );
      drawGrid(ctx, t, visible, cam.zoom);
      const { cities: current, roads: currentRoads, districts: currentDistricts, selection: sel } = model.current;
      for (const d of currentDistricts) {
        drawDistrict(ctx, t, d, sel?.type === 'district' && sel.id === d.id, cam.zoom);
      }
      drawTerrain(
        ctx,
        t,
        visible,
        current.map((c) => c.plot.pos),
      );
      const byNumber = new Map(current.map((c) => [c.task.taskNumber, c]));
      for (const city of current) {
        const parent = city.task.parentTaskNumber != null ? byNumber.get(city.task.parentTaskNumber) : undefined;
        if (parent) drawPath(ctx, t, parent.plot.pos, city.plot.pos);
      }
      const selectedTask = selectedTaskNumber(sel);
      currentRoads.forEach((road, index) => {
        const from = byNumber.get(road.from);
        const to = byNumber.get(road.to);
        if (!from || !to) return;
        const touches = selectedTask != null && (road.from === selectedTask || road.to === selectedTask);
        drawRoad(ctx, t, from.plot.pos, to.plot.pos, time, animate, index, touches, `#${road.to}`);
      });
      const ordered = [...current].sort((a, b) => a.plot.pos.y - b.plot.pos.y);
      for (const city of ordered) {
        const p = city.plot.pos;
        if (
          p.x + CITY_HALF_W < tl.x - 60 ||
          p.x - CITY_HALF_W > br.x + 60 ||
          p.y + CITY_HALF_H < tl.y - 120 ||
          p.y - CITY_HALF_H > br.y + 100
        )
          continue;
        if (selectedTask === city.task.taskNumber || linkingRef.current === city.task.taskNumber) {
          drawSelectionRing(ctx, t, p, cam.zoom, time, animate);
        }
        const drawable: DrawCity = {
          taskNumber: city.task.taskNumber,
          presence: cityPresence(city.task.status),
          pos: p,
          color: city.color,
          sites: city.sites.map((s) => ({ slot: s.slot, state: s.state })),
          built: city.plot.built,
        };
        drawCity(ctx, t, drawable, time, animate);
      }
    };

    const animated = () => {
      if (tween.current) return true;
      if (reduced.matches) return false;
      const { cities: current, roads: currentRoads, selection: sel } = model.current;
      if (sel || linkingRef.current != null || currentRoads.length > 0) return true;
      return current.some(
        (c) =>
          c.task.status === 'in_review' ||
          (c.task.status !== 'done' && c.sites.some((s) => s.state !== 'done' && s.state !== 'exited')),
      );
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
      if (dirty.current || animated()) {
        draw(now);
        dirty.current = false;
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [toWorld, saveViewport]);

  const hit = useCallback(
    (sx: number, sy: number): Hit => {
      const w = toWorld(sx, sy);
      const { cities: current, districts: currentDistricts, selection: sel } = model.current;
      const ordered = [...current].sort((a, b) => b.plot.pos.y - a.plot.pos.y);
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
        setStatus: async (status) => {
          await window.api.task.setStatus(projectPath, task.taskNumber, status);
          store.loadTasks(projectPath);
        },
        completeToDone: () => void completeTask({ projectPath, task }),
        trash: async () => {
          await window.api.task.trash(projectPath, task.taskNumber);
          store.loadTasks(projectPath);
          store.addToast('Task moved to trash', 'success');
        },
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
        items.push({
          label: 'Remove road',
          icon: 'trash',
          submenu: touching.map((road) => {
            const other = road.from === task.taskNumber ? road.to : road.from;
            const name = byNumber.get(other)?.task.name ?? `#${other}`;
            return {
              label: road.from === task.taskNumber ? `→ #${other} ${name}` : `← #${other} ${name}`,
              onClick: () => {
                map.removeRoad(projectPath, road.id);
                persistCityMap(projectPath);
              },
            };
          }),
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
          const district = useCityMapStore.getState().addDistrict(projectPath, world);
          persistCityMap(projectPath);
          select({ type: 'district', id: district.id });
        },
      },
      { label: 'New ticket', icon: 'plus', onClick: () => openTaskComposer() },
    ],
    [projectPath, select],
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
      else items = districtMenuItems(target.district);
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [cityMenuItems, siteMenuItems, districtMenuItems, groundMenuItems],
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
      // one step from where the drag began.
      if (pointer.hit?.type === 'city' && pointer.origin) {
        map.moveCity(projectPath, pointer.hit.city.task.taskNumber, {
          x: pointer.origin.x + total.x,
          y: pointer.origin.y + total.y,
        });
      } else if (pointer.hit?.type === 'district' && pointer.origin) {
        const next = { x: pointer.origin.x + total.x, y: pointer.origin.y + total.y };
        map.moveDistrict(
          projectPath,
          pointer.hit.district.id,
          { x: next.x - pointer.last.x, y: next.y - pointer.last.y },
          pointer.inside,
        );
        pointer.last = next;
      } else if (pointer.hit?.type === 'districtCorner' && pointer.size) {
        const { s: alongW, t: alongH } = isoDelta(total.x, total.y);
        map.updateDistrict(projectPath, pointer.hit.district.id, {
          w: pointer.size.x + alongW,
          h: pointer.size.y + alongH,
        });
      } else {
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
        } else select({ type: 'district', id: h.district.id });
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
    for (const city of cities) {
      const top = toScreen({ x: city.plot.pos.x, y: city.plot.pos.y - CITY_HALF_H });
      const selected = selectedTask === city.task.taskNumber;
      const faded = city.task.status === 'done';
      const waiting = city.sites.filter((s) => s.state === 'waiting').length;
      const problems = city.sites.filter((s) => s.state === 'error').length;
      nodes.push(
        <button
          key={`city-${city.task.taskNumber}`}
          type="button"
          data-testid={`city-label-${city.task.taskNumber}`}
          className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-full flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-lg border text-xs whitespace-nowrap transition-opacity ${selected ? 'border-accent' : 'border-border'} ${faded && !selected ? 'opacity-70' : ''} ${linking != null && linking !== city.task.taskNumber ? 'ring-2 ring-accent/40' : ''}`}
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
        const alert = site.state === 'waiting' || site.state === 'error';
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
    districts,
    selection,
    linking,
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
    containerRef,
    probeRef,
    labels,
    flyTo,
    onContextMenu,
    menu,
    closeMenu: () => setMenu(null),
    linking,
    cancelLinking: () => setLinking(null),
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

function AlertBadge({ count, state }: { count: number; state: 'waiting' | 'error' }) {
  return (
    <span
      className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full font-mono text-[10px] font-semibold text-white"
      style={{ background: SITE_COLOR[state] }}
      title={state === 'waiting' ? `${count} waiting for you` : `${count} with a problem`}
      data-testid={`city-alert-${state}`}
    >
      {count}
    </span>
  );
}

interface CitySidebarProps {
  width: number;
  cities: CityModel[];
  selection: CityMapSelection | null;
  looseTerminals: number;
  onPick: (city: CityModel) => void;
  onPickSite: (city: CityModel, site: SiteModel) => void;
}

function CitySidebar({ width, cities, selection, looseTerminals, onPick, onPickSite }: CitySidebarProps) {
  const waiting: { city: CityModel; site: SiteModel }[] = [];
  const problems: { city: CityModel; site: SiteModel }[] = [];
  let working = 0;
  for (const city of cities) {
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
      <div className="px-3 py-2">
        <button type="button" className="btn-secondary w-full text-xs" onClick={() => openTaskComposer()}>
          + New ticket
        </button>
      </div>
      {STATUS_ORDER.map((status) => {
        const group = cities
          .filter((c) => c.task.status === status)
          .sort((a, b) => b.task.taskNumber - a.task.taskNumber);
        return (
          <div key={status} className="px-2 pt-2 pb-1">
            <h3 className="mx-2 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary flex items-center gap-2">
              {STATUS_LABELS[status]} <span className="font-mono font-medium">{group.length}</span>
            </h3>
            {group.length === 0 && <div className="mx-2 mb-1 text-xs text-text-tertiary">Nothing here</div>}
            {group.map((city) => {
              const selected = selectedTask === city.task.taskNumber;
              return (
                <button
                  key={city.task.taskNumber}
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
                  <span className="flex gap-0.5">
                    {city.sites.map((s) => (
                      <SiteDot key={s.ptyId} state={s.state} className="!w-1.5 !h-1.5" />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
      {looseTerminals > 0 && (
        <div className="mt-auto px-4 py-3 text-[11px] text-text-tertiary border-t border-border">
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

interface CityInspectorProps {
  projectPath: string;
  city: CityModel;
  site?: SiteModel;
  district?: District;
  onClose: () => void;
  onSelectSite: (site: SiteModel) => void;
  onBackToCity: () => void;
  onOpenTerminal: (ptyId: string | null) => void;
  onContextMenu: (e: React.MouseEvent, target: Hit) => void;
}

function CityInspector({
  projectPath,
  city,
  site,
  district,
  onClose,
  onSelectSite,
  onBackToCity,
  onOpenTerminal,
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
  const setStatus = async (status: TaskStatus) => {
    if (status === 'done') {
      await completeTask({ projectPath, task });
      return;
    }
    await window.api.task.setStatus(projectPath, task.taskNumber, status);
    useProjectStore.getState().loadTasks(projectPath);
  };

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
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
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
          <button
            type="button"
            className="text-text-tertiary hover:text-text-primary"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <Icon name="x" className="w-3.5 h-3.5" />
          </button>
        </div>
        <input
          className="w-full bg-transparent border border-transparent hover:border-border focus:border-accent rounded-md px-1.5 -mx-1.5 py-0.5 text-base font-semibold text-text-primary outline-none"
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
          onChange={(e) => void setStatus(e.target.value as TaskStatus)}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="p-4 border-b border-border">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2">Description</h4>
        {task.prompt ? (
          <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed">{task.prompt}</p>
        ) : (
          <p className="text-xs text-text-tertiary italic">No description yet. Add one on the board.</p>
        )}
      </div>
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
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
          <span>Site</span>
          <button
            type="button"
            className="normal-case tracking-normal font-medium text-text-secondary hover:text-text-primary truncate"
            onClick={onBack}
          >
            in #{city.task.taskNumber} {city.task.name}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className="text-text-tertiary hover:text-text-primary"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <Icon name="x" className="w-3.5 h-3.5" />
          </button>
        </div>
        <input
          className="w-full bg-transparent border border-transparent hover:border-border focus:border-accent rounded-md px-1.5 -mx-1.5 py-0.5 text-base font-semibold text-text-primary outline-none"
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
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: districtColor(district.hue, 1, false) }} />
          <span>District</span>
          <span className="flex-1" />
          <button
            type="button"
            className="text-text-tertiary hover:text-text-primary"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <Icon name="x" className="w-3.5 h-3.5" />
          </button>
        </div>
        <input
          className="w-full bg-transparent border border-transparent hover:border-border focus:border-accent rounded-md px-1.5 -mx-1.5 py-0.5 text-base font-semibold text-text-primary outline-none"
          value={name}
          aria-label="District name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setName(district.name);
          }}
        />
        <div className="flex gap-1.5" role="radiogroup" aria-label="District colour">
          {DISTRICT_HUES.map((hue) => (
            <button
              key={hue}
              type="button"
              role="radio"
              aria-checked={district.hue === hue}
              aria-label={`Hue ${hue}`}
              className={`w-5 h-5 rounded-full border-2 ${district.hue === hue ? 'border-ink' : 'border-transparent'}`}
              style={{ background: districtColor(hue, 0.85, false) }}
              onClick={() => update({ hue })}
            />
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
          <button
            key={city.task.taskNumber}
            type="button"
            className="flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs hover:bg-ink/[0.04]"
            onClick={() => onPickCity(city)}
          >
            <span className="w-2 h-2 rounded-[2px] rotate-45" style={{ background: city.color }} />
            <span className="truncate text-text-primary">{city.task.name}</span>
            <span className="font-mono text-[10px] text-text-tertiary">#{city.task.taskNumber}</span>
          </button>
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
