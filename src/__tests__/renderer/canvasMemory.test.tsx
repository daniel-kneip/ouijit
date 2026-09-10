import { describe, test, expect } from 'vitest';
import { ChunkCache } from '../../components/citymap/drawTerrain';
import { canvasCaches } from '../../components/citymap/canvasMemory';

const paint = (w: number, h: number) => (canvas: HTMLCanvasElement) => {
  canvas.width = w;
  canvas.height = h;
};

describe('chunk cache memory', () => {
  test('a chunk that leaves the cache gives its bitmap back at once, and a disposed cache leaves the report', () => {
    const cache = new ChunkCache('test', 2 * 1000 * 1000 * 4);
    expect(Array.from(canvasCaches)).toContain(cache);
    const first = cache.get('a', paint(1000, 1000));
    cache.get('b', paint(1000, 1000));
    expect(cache.stats()).toEqual({ entries: 2, bytes: 8_000_000 });

    cache.get('c', paint(1000, 1000));
    expect(cache.stats().entries).toBe(2);
    expect(first.width).toBe(0);

    const kept = cache.get('c', paint(1, 1));
    expect(kept.width).toBe(1000);

    cache.reset('other world');
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(kept.width).toBe(0);

    cache.dispose();
    expect(Array.from(canvasCaches)).not.toContain(cache);
  });
});
