import { describe, test, expect } from 'vitest';
import {
  cellOf,
  cityCells,
  daylightTint,
  groundColour,
  isWater,
  latticePoint,
  riverCentre,
  roadRoute,
  routeCells,
  terrainCell,
  windowsLit,
} from '../components/citymap/terrain';
import { N } from '../components/citymap/cityGeometry';
import type { District } from '../stores/cityMapStore';

describe('the land under the cities', () => {
  test('cells sit on the lattice, the river runs where its centre line says, and lakes lie off it', () => {
    for (const [s, t] of [
      [0, 0],
      [7, -3],
      [-12, 40],
    ]) {
      expect(cellOf(latticePoint(s, t))).toEqual({ s, t });
    }
    for (let s = -80; s <= 80; s += 5) expect(isWater(s, Math.round(riverCentre(s)))).toBe(true);
    let lakes = 0;
    for (let s = -60; s < 60; s++) {
      for (let t = -60; t < 60; t++) {
        if (isWater(s, t) && Math.abs(t - riverCentre(s)) > 4) lakes++;
      }
    }
    expect(lakes).toBeGreaterThan(20);
  });

  test('the land is one green in close shades, darker at night, with open water left to the theme', () => {
    const day = groundColour(terrainCell(5, 5), false);
    const night = groundColour(terrainCell(5, 5), true);
    expect(day).toMatch(/^hsl\(/);
    expect(Number(/(\d+)%\)$/.exec(night)![1])).toBeLessThan(Number(/(\d+)%\)$/.exec(day)![1]));
    expect(groundColour(terrainCell(10, Math.round(riverCentre(10))), false)).toBe('');
    expect(terrainCell(3, 3)).toEqual(terrainCell(3, 3));
  });

  test('a district lays its own landscape over the land, water included', () => {
    const at = latticePoint(200, 200);
    const zone = (terrain: District['terrain']): District => ({
      id: terrain,
      name: terrain,
      x: at.x,
      y: at.y - 200,
      w: 400,
      h: 400,
      hue: 0,
      terrain,
    });
    const grounds = new Set<string>();
    for (let s = 195; s <= 210; s++) {
      for (let t = 195; t <= 210; t++) {
        const cell = terrainCell(s, t, [zone('volcanic')]);
        if (cell.zone) grounds.add(cell.ground);
      }
    }
    expect([...grounds].every((g) => g === 'rock' || g === 'lava' || g === 'water')).toBe(true);
    expect(grounds.has('lava')).toBe(true);
    expect(terrainCell(200, 200, [zone('glacier')]).ground).toBe('ice');
    expect(terrainCell(200, 200, [zone('salt')]).zone).toBe('salt');
    expect(terrainCell(300, 300, [zone('salt')]).zone).toBeUndefined();
    // A river cell in a salt district is brine, and it has a colour of its own rather than the theme's water.
    const river = Math.round(riverCentre(10));
    const salty = zone('salt');
    const onRiver = terrainCell(10, river, [
      { ...salty, ...latticePoint(10, river), y: latticePoint(10, river).y - 100 },
    ]);
    expect(onRiver.ground).toBe('brine');
    expect(groundColour(onRiver, false)).toMatch(/^hsl\(/);
  });

  test('a road leaves one city along the lattice, bends once, arrives at the other, and bridges the river', () => {
    const a = latticePoint(0, 0);
    const straight = roadRoute(a, latticePoint(20, 1));
    expect(straight.map(cellOf)).toEqual([
      { s: 4, t: 0 },
      { s: 16, t: 0 },
    ]);
    const footprint = cityCells(a);
    expect(footprint).toEqual({ s0: -3, s1: 3, t0: -3, t1: 3 });
    expect(cellOf(straight[0]).s).toBe(footprint.s1 + 1);

    const bent = roadRoute(a, latticePoint(20, 12));
    expect(bent.map(cellOf)).toEqual([
      { s: 4, t: 0 },
      { s: 20, t: 0 },
      { s: 20, t: 8 },
    ]);
    const cells = routeCells(bent);
    expect(cells).toHaveLength(1 + 16 + 8);
    expect(cells[0]).toEqual({ s: 4, t: 0 });
    expect(cells.at(-1)).toEqual({ s: 20, t: 8 });

    // The other way round the road turns along the t axis first.
    expect(roadRoute(a, latticePoint(3, 20)).map(cellOf)[0]).toEqual({ s: 0, t: 4 });
    expect(roadRoute(a, latticePoint(2, 2))).toEqual([]);

    // Two cities on either bank: the road between them crosses water.
    const river = Math.round(riverCentre(10));
    const across = roadRoute(latticePoint(10, river - 8), latticePoint(10, river + 8));
    expect(routeCells(across).some((c) => isWater(c.s, c.t))).toBe(true);
    expect(N).toBe(7);
  });

  test('the light follows the clock, and windows come on in the evening or at night', () => {
    const at = (hour: number) => new Date(2026, 8, 9, hour, 0, 0);
    expect(daylightTint(at(12), false)).toBeNull();
    expect(daylightTint(at(18), false)?.op).toBe('multiply');
    expect(daylightTint(at(18), false)?.colour).toContain('255,165,80');
    expect(daylightTint(at(23), false)?.colour).toContain('40,55,95');
    expect(daylightTint(at(23), true)).toBeNull();
    expect(daylightTint(at(6), false)?.colour).toContain('190,170,220');
    expect(windowsLit(at(12), false)).toBe(false);
    expect(windowsLit(at(19), false)).toBe(true);
    expect(windowsLit(at(12), true)).toBe(true);
  });
});
