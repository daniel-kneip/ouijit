import { describe, test, expect } from 'vitest';
import {
  N,
  cityLayout,
  cityPresence,
  cityStyle,
  freePosition,
  nextFreeSlot,
  seasonFor,
  siteState,
  weatherFor,
} from '../components/citymap/cityGeometry';

describe('a city is laid out from its task number', () => {
  test('the same task always gets the same city, roads through the middle, sites on lots first', () => {
    const a = cityLayout(42);
    const b = cityLayout(42);
    expect(a).toBe(b);
    expect(a.cells).toHaveLength(N * N);

    const mid = (N - 1) / 2;
    for (const cell of a.cells) {
      if (cell.i === mid || cell.j === mid) expect(cell.type).toBe('road');
      else expect(cell.type).not.toBe('road');
    }

    expect(a.slots.length).toBe(a.cells.filter((c) => c.type !== 'road').length);
    const cellAt = (i: number, j: number) => a.cells.find((c) => c.i === i && c.j === j)!;
    const lotCount = a.cells.filter((c) => c.type === 'lot').length;
    for (const slot of a.slots.slice(0, lotCount)) expect(cellAt(slot.i, slot.j).type).toBe('lot');

    expect(cityLayout(43).cells).not.toEqual(a.cells);
  });

  test('lots are handed out lowest first and skip finished buildings', () => {
    expect(nextFreeSlot([], 5)).toBe(0);
    expect(nextFreeSlot([0, 2], 5)).toBe(1);
    expect(nextFreeSlot([0, 1, 2, 3, 4], 5)).toBeNull();
  });

  test('a new city is founded clear of the existing ones', () => {
    const first = freePosition([]);
    expect(first).toEqual({ x: 0, y: 0 });
    const cities = [first];
    for (let k = 0; k < 6; k++) {
      const next = freePosition(cities);
      for (const c of cities) expect(Math.hypot(c.x - next.x, (c.y - next.y) * 1.4)).toBeGreaterThanOrEqual(470);
      cities.push(next);
    }
  });

  test('a site reads the terminal the way the card header does', () => {
    expect(siteState({ summaryType: 'thinking', hookStatus: null, exited: false })).toBe('working');
    expect(siteState({ summaryType: 'ready', hookStatus: 'thinking', exited: false })).toBe('working');
    expect(siteState({ summaryType: 'ready', hookStatus: 'ready', exited: false })).toBe('waiting');
    expect(siteState({ summaryType: 'error', hookStatus: null, exited: false })).toBe('error');
    expect(siteState({ summaryType: 'success', hookStatus: null, exited: false })).toBe('done');
    expect(siteState({ summaryType: 'thinking', hookStatus: null, exited: true })).toBe('exited');
  });

  test('presence follows the task status', () => {
    expect(['todo', 'in_progress', 'in_review', 'done'].map((s) => cityPresence(s as never))).toEqual([
      'blueprint',
      'building',
      'review',
      'settled',
    ]);
  });

  test('a chain shares one landscape and architecture, the calendar sets the season, the sites set the sky', () => {
    expect(cityStyle(7)).toEqual(cityStyle(7));
    const styles = new Set(Array.from({ length: 40 }, (_, n) => JSON.stringify(cityStyle(n + 1))));
    expect(styles.size).toBeGreaterThan(8);

    const now = Date.parse('2026-09-07T12:00:00Z');
    const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();
    expect(seasonFor(daysAgo(0), now)).toBe('spring');
    expect(seasonFor(daysAgo(5), now)).toBe('summer');
    expect(seasonFor(daysAgo(20), now)).toBe('autumn');
    expect(seasonFor(daysAgo(90), now)).toBe('winter');
    expect(seasonFor('not a date', now)).toBe('spring');

    expect(weatherFor([])).toBe('clear');
    expect(weatherFor(['waiting', 'done'])).toBe('clear');
    expect(weatherFor(['waiting', 'working'])).toBe('clouds');
    expect(weatherFor(['working', 'error', 'done'])).toBe('rain');
  });
});
