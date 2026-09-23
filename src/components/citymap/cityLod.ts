import { CITY_HALF_H, CITY_HALF_W } from './cityGeometry';
import { drawCity, type DrawCity, type MapTokens } from './drawCity';
import { canvasCaches, releaseCanvas } from './canvasMemory';

type Ctx = CanvasRenderingContext2D;

/** Zoom below which a city is a bitmap: its cranes and dust are a few pixels there, and it is one of many. */
export const CITY_BITMAP_ZOOM = 0.7;

/** Room round the ground for what stands over it: cranes, flags and clouds above, the slab's edge below. */
const ABOVE = 120;
const BESIDE = 24;
const BELOW = 24;

/**
 * Cities drawn once into their own bitmap and blitted while the map is far
 * out. A city is redrawn when what it shows changes, which the key spells out.
 */
export class CityBitmaps {
  readonly name = 'cities';
  private cache = new Map<number, { key: string; canvas: HTMLCanvasElement }>();

  constructor() {
    canvasCaches.add(this);
  }

  draw(ctx: Ctx, t: MapTokens, city: DrawCity, zoom: number): void {
    const scale = zoom <= 0.5 ? 0.5 : 1;
    const key = [
      scale,
      city.presence,
      city.color,
      city.sites.map((s) => `${s.slot}:${s.state}`).join(','),
      city.built.join(','),
      city.style.biome,
      city.style.culture,
      city.season,
      city.weather,
      t.night ? 'n' : 'd',
      t.lit ? 'l' : 'u',
    ].join('|');
    let entry = this.cache.get(city.taskNumber);
    if (!entry || entry.key !== key) {
      const canvas = entry?.canvas ?? document.createElement('canvas');
      const width = (CITY_HALF_W + BESIDE) * 2;
      const height = CITY_HALF_H + ABOVE + CITY_HALF_H + BELOW;
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const bctx = canvas.getContext('2d');
      if (!bctx) return;
      bctx.setTransform(scale, 0, 0, scale, (CITY_HALF_W + BESIDE) * scale, (CITY_HALF_H + ABOVE) * scale);
      drawCity(bctx, t, { ...city, pos: { x: 0, y: 0 } });
      entry = { key, canvas };
      this.cache.set(city.taskNumber, entry);
    }
    ctx.drawImage(
      entry.canvas,
      city.pos.x - CITY_HALF_W - BESIDE,
      city.pos.y - CITY_HALF_H - ABOVE,
      (CITY_HALF_W + BESIDE) * 2,
      CITY_HALF_H + ABOVE + CITY_HALF_H + BELOW,
    );
  }

  stats(): { entries: number; bytes: number } {
    let bytes = 0;
    for (const { canvas } of this.cache.values()) bytes += canvas.width * canvas.height * 4;
    return { entries: this.cache.size, bytes };
  }

  forget(taskNumber: number): void {
    const entry = this.cache.get(taskNumber);
    if (!entry) return;
    releaseCanvas(entry.canvas);
    this.cache.delete(taskNumber);
  }

  dispose(): void {
    for (const { canvas } of this.cache.values()) releaseCanvas(canvas);
    this.cache.clear();
    canvasCaches.delete(this);
  }
}
