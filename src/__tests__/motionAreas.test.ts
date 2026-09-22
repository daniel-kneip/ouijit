import { describe, expect, it } from 'vitest';
import { CITY_MOTION_REACH } from '../components/citymap/drawCity';
import { motionAreas, type MotionCity } from '../components/citymap/motionAreas';

const VIEW = { x0: 0, y0: 0, x1: 4000, y1: 3000 };

function city(taskNumber: number, x: number, states: MotionCity['states'], hidden = false): MotionCity {
  return { taskNumber, pos: { x, y: 1000 }, hidden, states };
}

describe('motionAreas', () => {
  it('asks for the cities at work, and for nothing else', () => {
    const areas = motionAreas(
      [
        city(1, 200, ['working']),
        city(2, 700, ['done', 'waiting']),
        city(3, 1200, ['error']),
        city(4, 1700, ['done', 'exited']),
        city(5, 2200, []),
        city(6, 2700, ['working'], true),
        city(7, 9000, ['working']),
      ],
      VIEW,
      new Set(),
    );
    expect(areas?.map((a) => a.x0)).toEqual([
      200 - CITY_MOTION_REACH.left,
      700 - CITY_MOTION_REACH.left,
      1200 - CITY_MOTION_REACH.left,
    ]);
    expect(areas?.[0]).toEqual({
      x0: 200 - CITY_MOTION_REACH.left,
      y0: 1000 - CITY_MOTION_REACH.top,
      x1: 200 + CITY_MOTION_REACH.right,
      y1: 1000 + CITY_MOTION_REACH.bottom,
    });
  });

  it('keeps a still city that wears a ring, so its dashes travel', () => {
    const cities = [city(1, 200, ['done']), city(2, 700, ['done'])];
    expect(motionAreas(cities, VIEW, new Set())).toEqual([]);
    expect(motionAreas(cities, VIEW, new Set([2]))).toHaveLength(1);
  });

  it('gives up on patches once they cover half the view', () => {
    const dense = Array.from({ length: 6 }, (_, i) => city(i, 200 + i * 250, ['working']));
    expect(motionAreas(dense, VIEW, new Set())).toHaveLength(6);
    expect(motionAreas(dense, { x0: 0, y0: 600, x1: 1500, y1: 1400 }, new Set())).toBeNull();
  });
});
