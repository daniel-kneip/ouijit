import {
  CITY_HALF_H,
  CITY_HALF_W,
  N,
  STOREY,
  TH,
  TW,
  cellCenter,
  cityLayout,
  hash2,
  type CityPresence,
  type Point,
  type SiteState,
} from './cityGeometry';

export interface MapTokens {
  ground: string;
  groundLine: string;
  water: string;
  path: string;
  surface: string;
  ink: string;
  ink2: string;
  accent: string;
  working: string;
  waiting: string;
  error: string;
  done: string;
  exited: string;
  review: string;
  night: boolean;
}

export interface DrawSite {
  slot: number;
  state: SiteState;
}

export interface DrawCity {
  taskNumber: number;
  presence: CityPresence;
  pos: Point;
  /** The task colour, as an `hsl(...)` string. */
  color: string;
  sites: DrawSite[];
  built: number[];
}

type Ctx = CanvasRenderingContext2D;

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

const toneCache = new Map<string, string>();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function tone(hex: string, s = 1, l = 0): string {
  const key = `${hex}|${s}|${l}`;
  let v = toneCache.get(key);
  if (!v) {
    const c = hexToHsl(hex);
    v = `hsl(${c.h.toFixed(0)} ${clamp(c.s * s, 0, 100).toFixed(0)}% ${clamp(c.l + l, 0, 100).toFixed(0)}%)`;
    toneCache.set(key, v);
  }
  return v;
}

/** `hsl(h, s%, l%)` from `getChainColor` with an alpha channel. */
export function withAlpha(hsl: string, alpha: number): string {
  return hsl.replace(/^hsl\(/, 'hsla(').replace(/\)$/, `, ${alpha})`);
}

function diamond(ctx: Ctx, cx: number, cy: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - h);
  ctx.lineTo(cx + w, cy);
  ctx.lineTo(cx, cy + h);
  ctx.lineTo(cx - w, cy);
  ctx.closePath();
}

interface BoxOptions {
  s?: number;
  l?: number;
  windows?: boolean;
  faded?: boolean;
}

function isoBox(
  ctx: Ctx,
  t: MapTokens,
  cx: number,
  cy: number,
  w: number,
  h: number,
  height: number,
  wall: string,
  o: BoxOptions = {},
): void {
  const l = o.l ?? 0;
  ctx.fillStyle = tone(wall, o.s, l);
  ctx.beginPath();
  ctx.moveTo(cx - w, cy - height);
  ctx.lineTo(cx, cy + h - height);
  ctx.lineTo(cx, cy + h);
  ctx.lineTo(cx - w, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = tone(wall, o.s, l - 14);
  ctx.beginPath();
  ctx.moveTo(cx + w, cy - height);
  ctx.lineTo(cx, cy + h - height);
  ctx.lineTo(cx, cy + h);
  ctx.lineTo(cx + w, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = tone(wall, o.s, l + 8);
  diamond(ctx, cx, cy - height, w, h);
  ctx.fill();

  if (!o.windows || height < STOREY) return;
  const storeys = Math.floor(height / STOREY);
  const lit = t.night && !o.faded;
  for (let s = 0; s < storeys; s++) {
    const base = height - s * STOREY - 4;
    for (const face of [-1, 1]) {
      for (const u1 of [0.28, 0.62]) {
        const u2 = u1 + 0.16;
        const X = (u: number) => cx + face * (w - w * u);
        const Y = (u: number) => cy + h * u;
        const on = lit && hash2(Math.round(cx * 7 + s * 31 + face * 3), Math.round(cy + u1 * 100)) < 0.65;
        ctx.fillStyle = on ? '#ffd98a' : t.night ? 'rgba(10,16,20,0.55)' : 'rgba(31,42,34,0.28)';
        ctx.beginPath();
        ctx.moveTo(X(u1), Y(u1) - base);
        ctx.lineTo(X(u2), Y(u2) - base);
        ctx.lineTo(X(u2), Y(u2) - base + 6);
        ctx.lineTo(X(u1), Y(u1) - base + 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

function tree(ctx: Ctx, t: MapTokens, cx: number, cy: number, scale = 1, faded = false): void {
  const g = faded ? tone('#5f9a4c', 0.25, 12) : tone('#5f9a4c', 1, t.night ? -10 : 0);
  const g2 = faded ? tone('#4a7f3a', 0.25, 12) : tone('#4a7f3a', 1, t.night ? -10 : 0);
  ctx.fillStyle = 'rgba(31,42,34,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1, 6 * scale, 3 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a6a48';
  ctx.fillRect(cx - 1.2 * scale, cy - 9 * scale, 2.4 * scale, 9 * scale);
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.arc(cx, cy - 12 * scale, 7 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx - 2 * scale, cy - 14 * scale, 5.5 * scale, 0, Math.PI * 2);
  ctx.fill();
}

function flag(ctx: Ctx, t: MapTokens, cx: number, cy: number, height: number, color: string): void {
  ctx.strokeStyle = t.ink2;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - height);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - height);
  ctx.lineTo(cx + 12, cy - height + 4);
  ctx.lineTo(cx, cy - height + 8);
  ctx.closePath();
  ctx.fill();
}

function stateColor(t: MapTokens, s: SiteState): string {
  return { working: t.working, waiting: t.waiting, error: t.error, done: t.done, exited: t.exited }[s];
}

function drawSite(
  ctx: Ctx,
  t: MapTokens,
  site: DrawSite,
  slot: { i: number; j: number; wall: string; storeys: number },
  time: number,
  animate: boolean,
  faded: boolean,
): void {
  const { x: cx, y: cy } = cellCenter(slot.i, slot.j);
  const col = stateColor(t, site.state);
  if (site.state === 'done') {
    isoBox(ctx, t, cx, cy, TW * 0.7, TH * 0.7, STOREY * slot.storeys, slot.wall, { windows: true, faded });
    flag(ctx, t, cx + TW * 0.55, cy + TH * 0.2, 26, col);
    return;
  }
  const exited = site.state === 'exited';
  ctx.fillStyle = tone('#e3d3a3', exited ? 0.2 : 1, t.night ? -18 : 0);
  diamond(ctx, cx, cy, TW * 0.92, TH * 0.92);
  ctx.fill();
  if (!exited) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#e07a2f';
    ctx.lineWidth = 1.2;
    diamond(ctx, cx, cy, TW * 0.92, TH * 0.92);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [px, py] of [
      [cx, cy - TH * 0.92],
      [cx + TW * 0.92, cy],
      [cx, cy + TH * 0.92],
      [cx - TW * 0.92, cy],
    ]) {
      ctx.fillStyle = '#e07a2f';
      ctx.fillRect(px - 1, py - 7, 2, 7);
      ctx.fillStyle = '#fff5e6';
      ctx.fillRect(px - 1, py - 4, 2, 2);
    }
  }
  isoBox(ctx, t, cx + 5, cy + 3, 6, 3, 4, '#c9b48a', { s: exited ? 0.2 : 1 });
  isoBox(ctx, t, cx - 6, cy + 1, TW * 0.3, TH * 0.3, 3, slot.wall, { s: exited ? 0.2 : 1 });

  const mastX = cx;
  const mastBase = cy - 3;
  const mastH = 48;
  const craneCol = exited ? t.exited : '#f2c14e';
  isoBox(ctx, t, mastX, mastBase, 2.6, 1.3, mastH, craneCol);
  const topY = mastBase - mastH;
  const baseAngle = -0.55;
  const angle = site.state === 'working' && animate ? baseAngle + Math.sin(time / 2600) * 0.55 : baseAngle;
  const jib = 34;
  const jx = mastX + Math.cos(angle) * jib;
  const jy = topY + Math.sin(angle) * jib * 0.5;
  ctx.strokeStyle = craneCol;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(mastX - Math.cos(angle) * 10, topY - Math.sin(angle) * 5);
  ctx.lineTo(jx, jy);
  ctx.stroke();
  const hookLen = site.state === 'working' && animate ? 14 + Math.sin(time / 1900) * 8 : 16;
  ctx.strokeStyle = t.ink2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(jx, jy);
  ctx.lineTo(jx, jy + hookLen);
  ctx.stroke();
  ctx.fillStyle = slot.wall;
  ctx.fillRect(jx - 3, jy + hookLen, 6, 4);

  if (site.state === 'working') {
    const puffs = animate ? 3 : 1;
    for (let k = 0; k < puffs; k++) {
      const ph = animate ? (time / 1500 + k / 3) % 1 : 0.4;
      ctx.fillStyle = `rgba(200,180,140,${(1 - ph) * 0.45})`;
      ctx.beginPath();
      ctx.arc(cx - 8 + k * 5, cy - 2 - ph * 18, 3 + ph * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (site.state === 'waiting') {
    const blink = animate ? 0.55 + 0.45 * Math.sin(time / 260) : 1;
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.18 * blink;
    ctx.beginPath();
    ctx.arc(mastX, topY - 8, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = blink;
    ctx.beginPath();
    ctx.arc(mastX, topY - 8, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    const pulse = animate ? (time / 1400) % 1 : 0.4;
    ctx.strokeStyle = col;
    ctx.globalAlpha = (1 - pulse) * 0.7;
    ctx.lineWidth = 1.5;
    diamond(ctx, cx, cy, TW * (0.9 + pulse * 0.6), TH * (0.9 + pulse * 0.6));
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (site.state === 'error') {
    for (let k = 0; k < 3; k++) {
      const ph = animate ? (time / 1800 + k / 3) % 1 : k / 3;
      ctx.fillStyle = `rgba(90,40,40,${(1 - ph) * 0.5})`;
      ctx.beginPath();
      ctx.arc(cx - 6 + Math.sin(ph * 6) * 3, cy - 4 - ph * 26, 3 + ph * 6, 0, Math.PI * 2);
      ctx.fill();
    }
    const by = topY - 12 + (animate ? Math.sin(time / 500) * 1.5 : 0);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(mastX, by - 9);
    ctx.lineTo(mastX + 8, by + 5);
    ctx.lineTo(mastX - 8, by + 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(mastX - 1, by - 4, 2, 5);
    ctx.fillRect(mastX - 1, by + 2, 2, 2);
  }
}

export function drawCity(ctx: Ctx, t: MapTokens, city: DrawCity, time: number, animate: boolean): void {
  const { cells, slots } = cityLayout(city.taskNumber);
  const faded = city.presence === 'settled';
  const blueprint = city.presence === 'blueprint';
  const opts: BoxOptions = faded ? { s: 0.22, l: t.night ? -6 : 10 } : { l: t.night ? -12 : 0 };
  ctx.save();
  ctx.translate(city.pos.x, city.pos.y);

  if (blueprint) {
    ctx.fillStyle = withAlpha(city.color, 0.12);
    diamond(ctx, 0, 0, CITY_HALF_W, CITY_HALF_H);
    ctx.fill();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = city.color;
    ctx.lineWidth = 2;
    diamond(ctx, 0, 0, CITY_HALF_W, CITY_HALF_H);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = faded ? tone('#b8cf9c', 0.2, t.night ? -30 : 8) : tone('#b8cf9c', 1, t.night ? -32 : 0);
    diamond(ctx, 0, 0, CITY_HALF_W, CITY_HALF_H);
    ctx.fill();
    ctx.strokeStyle = city.color;
    ctx.lineWidth = 2.5;
    diamond(ctx, 0, 0, CITY_HALF_W, CITY_HALF_H);
    ctx.stroke();
    ctx.fillStyle = withAlpha(city.color, 0.35);
    ctx.beginPath();
    ctx.moveTo(0, CITY_HALF_H + 2);
    ctx.lineTo(CITY_HALF_W + 2, 0);
    ctx.lineTo(CITY_HALF_W + 2, 6);
    ctx.lineTo(0, CITY_HALF_H + 8);
    ctx.lineTo(-CITY_HALF_W - 2, 6);
    ctx.lineTo(-CITY_HALF_W - 2, 0);
    ctx.closePath();
    ctx.fill();
  }

  const siteBySlot = new Map(city.sites.map((s) => [s.slot, s]));
  const builtBySlot = new Set(city.built);
  const slotByCell = new Map(slots.map((s, idx) => [`${s.i},${s.j}`, { idx, slot: s }]));
  const order = [...cells].sort((a, b) => a.i + a.j - (b.i + b.j));

  for (const cell of order) {
    const { x, y } = cellCenter(cell.i, cell.j);
    const here = slotByCell.get(`${cell.i},${cell.j}`);
    const site = here && siteBySlot.get(here.idx);
    const built = here && builtBySlot.has(here.idx);

    if (blueprint) {
      if (cell.type === 'road') {
        ctx.fillStyle = withAlpha(city.color, 0.1);
        diamond(ctx, x, y, TW, TH);
        ctx.fill();
      } else if (cell.type === 'building') {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = city.color;
        ctx.lineWidth = 1;
        diamond(ctx, x, y, TW * 0.7, TH * 0.7);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      continue;
    }

    if (cell.type === 'road') {
      ctx.fillStyle = faded ? tone('#9aa39c', 0.1, t.night ? -25 : 10) : tone('#a9b0a4', 1, t.night ? -30 : 0);
      diamond(ctx, x, y, TW, TH);
      ctx.fill();
      if (!faded && (cell.i + cell.j) % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
      continue;
    }
    if (site && here) {
      drawSite(ctx, t, site, here.slot, time, animate && !faded, faded);
      continue;
    }
    if (built && here) {
      isoBox(ctx, t, x, y, TW * 0.7, TH * 0.7, STOREY * here.slot.storeys, here.slot.wall, {
        ...opts,
        windows: true,
        faded,
      });
      continue;
    }
    if (cell.type === 'building') {
      isoBox(ctx, t, x, y, TW * 0.72, TH * 0.72, STOREY * cell.storeys, cell.wall, { ...opts, windows: true, faded });
    } else if (cell.type === 'park') {
      ctx.fillStyle = faded ? tone('#9cc27a', 0.2, t.night ? -28 : 10) : tone('#9cc27a', 1, t.night ? -30 : 0);
      diamond(ctx, x, y, TW * 0.9, TH * 0.9);
      ctx.fill();
      tree(ctx, t, x - 4, y + 2, 0.9, faded);
      if (cell.trees > 1) tree(ctx, t, x + 6, y - 2, 0.7, faded);
    } else {
      ctx.fillStyle = faded ? tone('#c3b995', 0.2, t.night ? -25 : 8) : tone('#c3b995', 1, t.night ? -28 : 0);
      diamond(ctx, x, y, TW * 0.8, TH * 0.8);
      ctx.fill();
    }
  }

  if (city.presence === 'review') {
    ctx.fillStyle = t.review;
    ctx.globalAlpha = 0.25;
    diamond(ctx, 0, 0, TW, TH);
    ctx.fill();
    ctx.globalAlpha = 1;
    flag(ctx, t, 0, 2, 44, t.review);
    const bob = animate ? Math.sin(time / 700) * 2 : 0;
    ctx.strokeStyle = t.review;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(14, -52 + bob, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(18, -48 + bob);
    ctx.lineTo(23, -43 + bob);
    ctx.stroke();
  } else if (city.presence === 'settled') {
    flag(ctx, t, 0, 2, 36, t.done);
  } else if (blueprint) {
    ctx.fillStyle = '#8a6a48';
    ctx.fillRect(-1, -18, 2, 18);
    ctx.fillStyle = '#f4e7c8';
    ctx.fillRect(-11, -30, 22, 13);
    ctx.strokeStyle = city.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(-11, -30, 22, 13);
    ctx.fillStyle = city.color;
    ctx.fillRect(-8, -26, 12, 1.5);
    ctx.fillRect(-8, -22, 8, 1.5);
  }
  ctx.restore();
}

export function drawSelectionRing(
  ctx: Ctx,
  t: MapTokens,
  pos: Point,
  zoom: number,
  time: number,
  animate: boolean,
): void {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = animate ? -(time / 40) % 14 : 0;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2 / zoom;
  diamond(ctx, 0, 0, CITY_HALF_W + 12, CITY_HALF_H + 8);
  ctx.stroke();
  ctx.restore();
}

export function drawTerrain(
  ctx: Ctx,
  t: MapTokens,
  visible: { x0: number; y0: number; x1: number; y1: number },
  cities: readonly Point[],
): void {
  const step = 170;
  const i0 = Math.floor(visible.x0 / step) - 1;
  const i1 = Math.ceil(visible.x1 / step) + 1;
  const j0 = Math.floor(visible.y0 / step) - 1;
  const j1 = Math.ceil(visible.y1 / step) + 1;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const h = hash2(i, j);
      if (h > 0.22) continue;
      const x = i * step + (hash2(i + 7, j) - 0.5) * 120;
      const y = j * step + (hash2(i, j + 7) - 0.5) * 120;
      if (cities.some((c) => Math.abs(c.x - x) < CITY_HALF_W + 50 && Math.abs(c.y - y) < CITY_HALF_H + 60)) continue;
      if (h < 0.03) {
        ctx.fillStyle = t.water;
        ctx.beginPath();
        ctx.ellipse(x, y, 34, 17, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.ellipse(x - 8, y - 4, 10, 4, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const n = 1 + Math.floor(h * 14);
        for (let k = 0; k < n; k++) {
          tree(ctx, t, x + (hash2(i + k, j) - 0.5) * 50, y + (hash2(i, j + k) - 0.5) * 30, 0.8 + hash2(k, i) * 0.5);
        }
      }
    }
  }
}

export function drawPath(ctx: Ctx, t: MapTokens, from: Point, to: Point): void {
  ctx.strokeStyle = t.path;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.setLineDash([12, 9]);
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(mx + 40, my - 60, to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Grid size in map units the iso ground lines repeat at. */
export const GRID = 44;
export { N };
