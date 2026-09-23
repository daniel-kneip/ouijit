import { describe, test, expect, beforeEach } from 'vitest';
import {
  DISTRICT_MIN_W,
  districtCorners,
  normalizeProjectState,
  pointInDistrict,
  useCityMapStore,
  type CityMapProjectState,
} from '../stores/cityMapStore';

const project = '/work/alpha';

beforeEach(() => {
  useCityMapStore.setState({ byProject: {}, openPtyId: {}, selection: {} });
});

describe('roads and districts on the map', () => {
  test('a road is one-way, never doubled, never to itself, and gone when removed', () => {
    const store = useCityMapStore.getState();
    store.ensureCity(project, 1);
    store.ensureCity(project, 2);
    store.addRoad(project, 1, 2);
    store.addRoad(project, 1, 2);
    store.addRoad(project, 2, 1);
    store.addRoad(project, 3, 3);
    const roads = useCityMapStore.getState().byProject[project].roads;
    expect(roads.map((r) => [r.from, r.to])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    store.removeRoad(project, roads[0].id);
    expect(useCityMapStore.getState().byProject[project].roads.map((r) => [r.from, r.to])).toEqual([[2, 1]]);
  });

  test('a district carries the cities inside it when moved and keeps a minimum size', () => {
    const store = useCityMapStore.getState();
    store.ensureCity(project, 1);
    store.ensureCity(project, 2);
    const inside = useCityMapStore.getState().byProject[project].cities[1].pos;
    const district = store.addDistrict(project, inside);
    expect(district.name).toBe('District 1');
    expect(pointInDistrict(district, inside)).toBe(true);
    // The rhombus lies on the cities' axes and is centred on the founding point.
    const [top, right, bottom, left] = districtCorners(district);
    expect(right.y - top.y).toBeCloseTo((right.x - top.x) / 2, 5);
    expect(left.y - top.y).toBeCloseTo((top.x - left.x) / 2, 5);
    expect((top.x + bottom.x) / 2).toBeCloseTo(inside.x, 0);
    expect((top.y + bottom.y) / 2).toBeCloseTo(inside.y, 0);
    const outside = useCityMapStore.getState().byProject[project].cities[2].pos;
    expect(pointInDistrict(district, outside)).toBe(false);

    store.moveDistrict(project, district.id, { x: 50, y: -20 }, [1]);
    const state = useCityMapStore.getState().byProject[project];
    expect(state.districts[0]).toMatchObject({ x: district.x + 50, y: district.y - 20 });
    expect(state.cities[1].pos).toEqual({ x: inside.x + 50, y: inside.y - 20 });
    expect(state.cities[2].pos).toEqual(outside);

    store.updateDistrict(project, district.id, { name: 'Payments', w: 10, hue: 90 });
    expect(useCityMapStore.getState().byProject[project].districts[0]).toMatchObject({
      name: 'Payments',
      w: DISTRICT_MIN_W,
      hue: 90,
    });
    store.removeDistrict(project, district.id);
    expect(useCityMapStore.getState().byProject[project].districts).toEqual([]);
  });

  test('a map saved before roads and districts existed still loads', () => {
    const old = { cities: { 1: { pos: { x: 0, y: 0 }, lots: {}, built: [] } }, viewport: { x: 0, y: 0, zoom: 1 } };
    expect(normalizeProjectState(old as Partial<CityMapProjectState>)).toEqual({ ...old, roads: [], districts: [] });
    expect(normalizeProjectState({})).toBeNull();
  });
});
