import {
  CITY_HALF_H,
  CITY_HALF_W,
  N,
  STOREY,
  TH,
  TW,
  WALLS,
  cellCenter,
  cityLayout,
  hash2,
  type Biome,
  type CityPresence,
  type CityStyle,
  type Culture,
  type Point,
  type Season,
  type SiteState,
  type Weather,
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
  style: CityStyle;
  season: Season;
  weather: Weather;
}

const CULTURE_WALLS: Record<Culture, string[]> = {
  modern: WALLS,
  oldtown: ['#f3e6c8', '#e9d3a6', '#d9c3a0', '#f0dcc0', '#e6cfae', '#f5ead4', '#dcc8a8', '#efe0c4'],
  mediterranean: ['#f7f1e6', '#f1e4cf', '#efe8dc', '#f5efe3', '#eadfcb', '#f8f3ea', '#e9dcc4', '#f3ebdd'],
  nordic: ['#6b4a35', '#8a5a3c', '#a04a3d', '#c9b08a', '#7a5540', '#b0603f', '#5e4130', '#d2bb96'],
  pagoda: ['#e9d8b8', '#d9c19a', '#b8473f', '#e2cfa8', '#c9ad7f', '#a63f38', '#efe0c2', '#d1b78f'],
  adobe: ['#e3c39a', '#d8b184', '#efd3ac', '#dcb98f', '#e8c9a0', '#cfa97c', '#f0d8b4', '#d6b58a'],
};
const CULTURE_ROOF: Record<Culture, string> = {
  modern: '',
  oldtown: '#b5493a',
  mediterranean: '#c96b3a',
  nordic: '#2f2f38',
  pagoda: '#3d4d5c',
  adobe: '#c9a072',
};

interface Ground {
  base: string;
  park: string;
  lot: string;
}

/** Ground colours by biome, with the season laid over the temperate ones. */
function groundFor(biome: Biome, season: Season): Ground {
  const snow = { base: '#e9eef0', park: '#dfe6ea', lot: '#d3d9dc' };
  switch (biome) {
    case 'desert':
      return { base: '#e5d3a1', park: '#d9c78f', lot: '#d2bd86' };
    case 'tropical':
      return { base: '#cfd9a0', park: '#a9cc7a', lot: '#dccf9a' };
    case 'tundra':
      return season === 'summer' ? { base: '#c6d3c4', park: '#b3c7ad', lot: '#bdc4bb' } : snow;
    case 'forest':
      if (season === 'winter') return snow;
      if (season === 'autumn') return { base: '#a8ac72', park: '#8f9b62', lot: '#b8a97c' };
      return { base: '#8fb37e', park: '#6f9a62', lot: '#a8a880' };
    case 'meadow':
    default:
      if (season === 'winter') return snow;
      if (season === 'autumn') return { base: '#c9c58a', park: '#b7b06d', lot: '#c3b995' };
      if (season === 'spring') return { base: '#c4dca4', park: '#a9d08c', lot: '#c8c39a' };
      return { base: '#b8cf9c', park: '#9cc27a', lot: '#c3b995' };
  }
}

function snowy(biome: Biome, season: Season): boolean {
  return season === 'winter' ? biome !== 'desert' && biome !== 'tropical' : biome === 'tundra';
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

interface BuildingOptions extends BoxOptions {
  culture: Culture;
  snow: boolean;
  /** Stable per building, so the same one always gets the dome or the tier. */
  seed: number;
}

/**
 * A building in the city's culture: the same box, then the roof the culture
 * builds on it. Flat roofs are the box's own top face.
 */
function drawBuilding(
  ctx: Ctx,
  t: MapTokens,
  cx: number,
  cy: number,
  w: number,
  h: number,
  height: number,
  wall: string,
  o: BuildingOptions,
): void {
  const palette = CULTURE_WALLS[o.culture];
  const colour = palette[Math.max(0, WALLS.indexOf(wall)) % palette.length];
  isoBox(ctx, t, cx, cy, w, h, height, colour, o);
  const roof = CULTURE_ROOF[o.culture];
  const roofColour = o.faded ? tone(roof || colour, 0.2, 10) : roof || colour;
  const top = cy - height;
  switch (o.culture) {
    case 'oldtown':
    case 'nordic': {
      const ridge = o.culture === 'nordic' ? h * 1.6 : h * 1.1;
      pitchedRoof(ctx, cx, top, w, h, ridge, roofColour);
      break;
    }
    case 'mediterranean': {
      ctx.strokeStyle = roofColour;
      ctx.lineWidth = 2;
      diamond(ctx, cx, top, w, h);
      ctx.stroke();
      if (o.seed > 0.6) dome(ctx, cx, top, w * 0.45, o.faded ? tone('#3b6fb6', 0.2, 20) : '#3b6fb6');
      break;
    }
    case 'pagoda': {
      ctx.fillStyle = roofColour;
      diamond(ctx, cx, top, w * 1.25, h * 1.25);
      ctx.fill();
      isoBox(ctx, t, cx, top - 2, w * 0.6, h * 0.6, 9, colour, { s: o.s, l: o.l });
      ctx.fillStyle = roofColour;
      diamond(ctx, cx, top - 11, w * 0.85, h * 0.85);
      ctx.fill();
      break;
    }
    case 'adobe': {
      if (o.seed > 0.55) dome(ctx, cx, top, w * 0.4, roofColour);
      break;
    }
    case 'modern':
    default:
      break;
  }
  if (o.snow) {
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    diamond(
      ctx,
      cx,
      top - (o.culture === 'pagoda' ? 11 : 0),
      w * (o.culture === 'pagoda' ? 0.85 : 1),
      h * (o.culture === 'pagoda' ? 0.85 : 1),
    );
    ctx.fill();
  }
}

function pitchedRoof(ctx: Ctx, cx: number, top: number, w: number, h: number, ridge: number, colour: string): void {
  const a = { x: cx - w / 2, y: top - h / 2 - ridge };
  const b = { x: cx + w / 2, y: top + h / 2 - ridge };
  ctx.fillStyle = tone(colour, 1, 6);
  ctx.beginPath();
  ctx.moveTo(cx - w, top);
  ctx.lineTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(cx, top + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = tone(colour, 1, -10);
  ctx.beginPath();
  ctx.moveTo(cx, top - h);
  ctx.lineTo(cx + w, top);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(a.x, a.y);
  ctx.closePath();
  ctx.fill();
}

function dome(ctx: Ctx, cx: number, top: number, r: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(cx, top, r, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, top - r * 0.2, r * 0.35, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
}

/** What grows in a park: the biome's plant, in the season's colour. */
function plant(
  ctx: Ctx,
  t: MapTokens,
  biome: Biome,
  season: Season,
  cx: number,
  cy: number,
  scale: number,
  faded: boolean,
): void {
  const snow = snowy(biome, season);
  switch (biome) {
    case 'forest':
    case 'tundra':
      conifer(
        ctx,
        cx,
        cy,
        scale,
        faded,
        snow || biome === 'tundra' ? '#5f8f7a' : season === 'autumn' ? '#8a8a3c' : '#3f7a4a',
        snow,
      );
      break;
    case 'desert':
      cactus(ctx, cx, cy, scale, faded);
      break;
    case 'tropical':
      palm(ctx, cx, cy, scale, faded);
      break;
    case 'meadow':
    default:
      tree(
        ctx,
        t,
        cx,
        cy,
        scale,
        faded,
        snow ? '#f2f5f4' : season === 'autumn' ? '#d98a3a' : season === 'spring' ? '#e9a7c4' : undefined,
      );
      break;
  }
}

function conifer(ctx: Ctx, cx: number, cy: number, scale: number, faded: boolean, colour: string, snow: boolean): void {
  const green = faded ? tone(colour, 0.25, 12) : colour;
  ctx.fillStyle = 'rgba(31,42,34,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1, 5 * scale, 2.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6b4a35';
  ctx.fillRect(cx - scale, cy - 5 * scale, 2 * scale, 5 * scale);
  for (const [w, y0, y1] of [
    [7, 5, 14],
    [5.5, 10, 18],
    [4, 15, 22],
  ]) {
    ctx.fillStyle = tone(green, 1, (y0 - 5) * 0.6);
    ctx.beginPath();
    ctx.moveTo(cx, cy - y1 * scale);
    ctx.lineTo(cx + w * scale, cy - y0 * scale);
    ctx.lineTo(cx - w * scale, cy - y0 * scale);
    ctx.closePath();
    ctx.fill();
    if (snow) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - y1 * scale);
      ctx.lineTo(cx + w * 0.55 * scale, cy - (y0 + (y1 - y0) * 0.45) * scale);
      ctx.lineTo(cx - w * 0.55 * scale, cy - (y0 + (y1 - y0) * 0.45) * scale);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function cactus(ctx: Ctx, cx: number, cy: number, scale: number, faded: boolean): void {
  const green = faded ? tone('#5f9a5c', 0.25, 12) : '#5f9a5c';
  ctx.fillStyle = 'rgba(31,42,34,0.15)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1, 4 * scale, 2 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = green;
  ctx.beginPath();
  ctx.roundRect(cx - 2 * scale, cy - 16 * scale, 4 * scale, 16 * scale, 2 * scale);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 7 * scale, cy - 11 * scale, 3 * scale, 6 * scale, 1.5 * scale);
  ctx.fill();
  ctx.fillRect(cx - 7 * scale, cy - 7 * scale, 5 * scale, 2 * scale);
  ctx.beginPath();
  ctx.roundRect(cx + 4 * scale, cy - 13 * scale, 3 * scale, 6 * scale, 1.5 * scale);
  ctx.fill();
  ctx.fillRect(cx + 2 * scale, cy - 9 * scale, 5 * scale, 2 * scale);
}

function palm(ctx: Ctx, cx: number, cy: number, scale: number, faded: boolean): void {
  const green = faded ? tone('#4f9f5a', 0.25, 12) : '#4f9f5a';
  ctx.fillStyle = 'rgba(31,42,34,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1, 5 * scale, 2.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#9a7048';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.quadraticCurveTo(cx + 3 * scale, cy - 10 * scale, cx + 5 * scale, cy - 18 * scale);
  ctx.stroke();
  ctx.strokeStyle = green;
  ctx.lineWidth = 2.2 * scale;
  ctx.lineCap = 'round';
  const tx = cx + 5 * scale;
  const ty = cy - 18 * scale;
  for (const a of [-2.6, -2.0, -1.2, -0.5, 0.2, 0.9]) {
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(
      tx + Math.cos(a) * 7 * scale,
      ty + Math.sin(a) * 7 * scale - 3 * scale,
      tx + Math.cos(a) * 10 * scale,
      ty + Math.sin(a) * 6 * scale + 3 * scale,
    );
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function tree(ctx: Ctx, t: MapTokens, cx: number, cy: number, scale = 1, faded = false, canopy?: string): void {
  const g = faded ? tone(canopy ?? '#5f9a4c', 0.25, 12) : tone(canopy ?? '#5f9a4c', 1, t.night ? -10 : 0);
  const g2 = faded ? tone(canopy ?? '#4a7f3a', 0.25, 12) : tone(canopy ?? '#4a7f3a', 1, t.night ? -18 : -8);
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
  const needsYou = site.state === 'waiting' || site.state === 'error';
  if (needsYou) {
    const pulse = animate ? 0.5 + 0.5 * Math.sin(time / 420) : 0.7;
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.18 + 0.14 * pulse;
    diamond(ctx, cx, cy, TW * 1.9, TH * 1.9);
    ctx.fill();
    ctx.globalAlpha = 0.55 + 0.35 * pulse;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    diamond(ctx, cx, cy, TW * 1.45, TH * 1.45);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
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

  if (needsYou) drawPin(ctx, mastX, topY - 16, col, site.state === 'waiting' ? '!' : '×', time, animate);
}

/** A marker that stands above everything on the lot, so it reads at any zoom the city itself reads at. */
function drawPin(
  ctx: Ctx,
  x: number,
  baseY: number,
  color: string,
  glyph: string,
  time: number,
  animate: boolean,
): void {
  const bob = animate ? Math.sin(time / 380) * 2 : 0;
  const top = baseY - 34 + bob;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, top + 10);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, baseY + 1, 5, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, top, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x, top + 0.5);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

export function drawCity(ctx: Ctx, t: MapTokens, city: DrawCity, time: number, animate: boolean): void {
  const { cells, slots } = cityLayout(city.taskNumber);
  const faded = city.presence === 'settled';
  const blueprint = city.presence === 'blueprint';
  const opts: BoxOptions = faded ? { s: 0.22, l: t.night ? -6 : 10 } : { l: t.night ? -12 : 0 };
  const { biome, culture } = city.style;
  const ground = groundFor(biome, city.season);
  const snow = snowy(biome, city.season);
  const shade = (hex: string, dark: number, light = 0) =>
    faded ? tone(hex, 0.2, light) : tone(hex, 1, t.night ? dark : 0);
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
    ctx.fillStyle = shade(ground.base, -32, 8);
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
    const seed = hash2(city.taskNumber * 31 + cell.i, cell.j);
    if (built && here) {
      drawBuilding(ctx, t, x, y, TW * 0.7, TH * 0.7, STOREY * here.slot.storeys, here.slot.wall, {
        ...opts,
        windows: true,
        faded,
        culture,
        snow,
        seed,
      });
      continue;
    }
    if (cell.type === 'building') {
      drawBuilding(ctx, t, x, y, TW * 0.72, TH * 0.72, STOREY * cell.storeys, cell.wall, {
        ...opts,
        windows: true,
        faded,
        culture,
        snow,
        seed,
      });
    } else if (cell.type === 'park') {
      ctx.fillStyle = shade(ground.park, -30, 10);
      diamond(ctx, x, y, TW * 0.9, TH * 0.9);
      ctx.fill();
      plant(ctx, t, biome, city.season, x - 4, y + 2, 0.9, faded);
      if (cell.trees > 1) plant(ctx, t, biome, city.season, x + 6, y - 2, 0.7, faded);
    } else {
      ctx.fillStyle = shade(ground.lot, -28, 8);
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
  if (!blueprint && !faded) drawWeather(ctx, city.weather, city.taskNumber, time, animate);
  ctx.restore();
}

/** Clouds drift over a city at work; a city with a problem sits under rain. */
function drawWeather(ctx: Ctx, weather: Weather, seed: number, time: number, animate: boolean): void {
  if (weather === 'clear') return;
  const rain = weather === 'rain';
  const drift = animate ? ((time / 90 + seed * 37) % (CITY_HALF_W * 2 + 120)) - CITY_HALF_W - 60 : -20;
  const y = -CITY_HALF_H - 62;
  const clouds = rain
    ? [{ x: drift, s: 1.15 }]
    : [
        { x: drift, s: 1 },
        { x: drift - 90, s: 0.7 },
      ];
  for (const c of clouds) {
    ctx.fillStyle = rain ? 'rgba(88,96,108,0.92)' : 'rgba(255,255,255,0.85)';
    for (const [dx, dy, r] of [
      [0, 0, 11],
      [-12, 4, 8],
      [13, 3, 9],
      [4, -6, 8],
    ]) {
      ctx.beginPath();
      ctx.arc(c.x + dx * c.s, y + dy * c.s, r * c.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = rain ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.07)';
    ctx.beginPath();
    ctx.ellipse(c.x, -6, 26 * c.s, 13 * c.s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!rain) return;
  const cx = clouds[0].x;
  ctx.strokeStyle = 'rgba(120,150,200,0.7)';
  ctx.lineWidth = 1;
  const fall = animate ? (time / 12) % 14 : 6;
  for (let k = -2; k <= 2; k++) {
    const x = cx + k * 8;
    for (let d = 0; d < 3; d++) {
      const yy = y + 14 + ((fall + d * 14 + k * 3) % 42);
      ctx.beginPath();
      ctx.moveTo(x + 1.5, yy);
      ctx.lineTo(x, yy + 6);
      ctx.stroke();
    }
  }
  const flash = animate && (time + seed * 700) % 4200 < 110;
  if (flash) {
    ctx.strokeStyle = '#ffe98a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 4, y + 10);
    ctx.lineTo(cx - 2, y + 26);
    ctx.lineTo(cx + 3, y + 26);
    ctx.lineTo(cx - 4, y + 44);
    ctx.stroke();
  }
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

/**
 * Ground lines along the two cell edges (slopes of ±1/2), one per cell row, so
 * a city's ground sits on the grid. Drawn in map space.
 */
export function drawGrid(
  ctx: Ctx,
  t: MapTokens,
  visible: { x0: number; y0: number; x1: number; y1: number },
  zoom: number,
): void {
  const step = 2 * TH;
  if (step * zoom < 7) return;
  ctx.strokeStyle = t.groundLine;
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (const slope of [0.5, -0.5]) {
    const cAt = (x: number, y: number) => y - slope * x;
    const cs = [
      cAt(visible.x0, visible.y0),
      cAt(visible.x1, visible.y0),
      cAt(visible.x0, visible.y1),
      cAt(visible.x1, visible.y1),
    ];
    const c0 = Math.floor(Math.min(...cs) / step) * step;
    const c1 = Math.ceil(Math.max(...cs) / step) * step;
    for (let c = c0; c <= c1; c += step) {
      ctx.moveTo(visible.x0, slope * visible.x0 + c);
      ctx.lineTo(visible.x1, slope * visible.x1 + c);
    }
  }
  ctx.stroke();
}

export interface DrawDistrict {
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number;
}

export function districtColor(hue: number, alpha: number, night: boolean): string {
  return `hsla(${hue}, 55%, ${night ? 62 : 45}%, ${alpha})`;
}

function districtPath(ctx: Ctx, d: DrawDistrict): void {
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(d.x + d.w, d.y + d.w / 2);
  ctx.lineTo(d.x + d.w - d.h, d.y + (d.w + d.h) / 2);
  ctx.lineTo(d.x - d.h, d.y + d.h / 2);
  ctx.closePath();
}

export function drawDistrict(ctx: Ctx, t: MapTokens, d: DrawDistrict, selected: boolean, zoom: number): void {
  districtPath(ctx, d);
  ctx.fillStyle = districtColor(d.hue, t.night ? 0.16 : 0.13, t.night);
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = (selected ? 2.5 : 1.5) / zoom;
  ctx.strokeStyle = selected ? t.accent : districtColor(d.hue, 0.7, t.night);
  ctx.setLineDash(selected ? [] : [10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (selected) {
    const size = 12 / zoom;
    const bx = d.x + d.w - d.h;
    const by = d.y + (d.w + d.h) / 2;
    ctx.fillStyle = t.accent;
    ctx.beginPath();
    ctx.roundRect(bx - size / 2, by - size / 2, size, size, 3 / zoom);
    ctx.fill();
  }
}

/** Where a straight road leaves a city: on the edge of its ground diamond. */
export function cityEdgePoint(center: Point, towards: Point): Point {
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const reach = 1 / (Math.abs(ux) / CITY_HALF_W + Math.abs(uy) / CITY_HALF_H);
  return { x: center.x + ux * reach * 1.04, y: center.y + uy * reach * 1.04 };
}

const CAR_COLOURS = ['#e0524d', '#3f7fd8', '#f2b134', '#3fa66b', '#f0f0f0', '#7a5cc9'];

/**
 * A one-way road from one city's edge to another's, with cars driving the
 * way the arrows point. `seed` staggers the cars between roads.
 */
export function drawRoad(
  ctx: Ctx,
  t: MapTokens,
  from: Point,
  to: Point,
  time: number,
  animate: boolean,
  seed: number,
  highlighted: boolean,
  destination: string,
): void {
  const a = cityEdgePoint(from, to);
  const b = cityEdgePoint(to, from);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 20) return;
  const angle = Math.atan2(dy, dx);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = highlighted ? t.accent : t.night ? '#4b5450' : '#8d938c';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.strokeStyle = t.night ? '#2f3633' : '#6f756f';
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Direction arrows painted on the asphalt, and a large one where the road arrives.
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.save();
  ctx.translate(b.x - (dx / len) * 12, b.y - (dy / len) * 12);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(-5, -6);
  ctx.lineTo(-1, 0);
  ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const f of [0.3, 0.7]) {
    const px = a.x + dx * f;
    const py = a.y + dy * f;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-3, -3.2);
    ctx.lineTo(-3, 3.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawSignpost(
    ctx,
    a.x + (dx / len) * 26 - (dy / len) * 16,
    a.y + (dy / len) * 26 + (dx / len) * 16,
    angle,
    destination,
  );

  const cars = Math.max(1, Math.min(4, Math.floor(len / 200)));
  for (let k = 0; k < cars; k++) {
    const phase = animate ? (time / (len * 14) + k / cars + seed * 0.37) % 1 : (k + 0.5) / cars;
    const px = a.x + dx * phase;
    const py = a.y + dy * phase;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.roundRect(-6, -2.5, 12, 6, 2);
    ctx.fill();
    ctx.fillStyle = CAR_COLOURS[(seed + k) % CAR_COLOURS.length];
    ctx.beginPath();
    ctx.roundRect(-6, -3.5, 12, 6, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.roundRect(-3, -2.5, 5, 4, 1);
    ctx.fill();
    ctx.fillStyle = '#fff6c2';
    ctx.fillRect(5, -3, 1.5, 2);
    ctx.fillRect(5, 1, 1.5, 2);
    ctx.restore();
  }
  ctx.restore();
}

/** A one-way sign beside the road's start: a white arrow the way traffic goes, the destination below. */
function drawSignpost(ctx: Ctx, x: number, y: number, angle: number, destination: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 5, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6b6f6a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 30);
  ctx.stroke();

  const cy = y - 38;
  ctx.fillStyle = '#2f6fd6';
  ctx.beginPath();
  ctx.arc(x, cy, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.save();
  ctx.translate(x, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-5, 0);
  ctx.lineTo(5, 0);
  ctx.moveTo(1.5, -3.5);
  ctx.lineTo(5, 0);
  ctx.lineTo(1.5, 3.5);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#6b6f6a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - 13, cy + 11, 26, 10, 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#1f2a22';
  ctx.font = 'bold 7px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(destination, x, cy + 16.5);
  ctx.restore();
}

export { N };
