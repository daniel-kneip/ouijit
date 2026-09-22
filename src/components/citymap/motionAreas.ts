import { type Point, type SiteState } from './cityGeometry';
import { CITY_MOTION_REACH } from './drawCity';

/** A rectangle of the world, in world units. */
export interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MotionCity {
  taskNumber: number;
  pos: Point;
  hidden: boolean;
  states: readonly SiteState[];
}

const STIRRING: ReadonlySet<SiteState> = new Set<SiteState>(['working', 'waiting', 'error']);

/**
 * What a motion frame has to repaint: the cities on screen with a site at work or in
 * trouble, plus `ringed` (the selected city, the one being linked) for their dashes.
 * Nothing else on the map moves, so nothing else needs painting again.
 * `null` asks for the whole scene instead, for where the parts that move cover so much
 * of the view that clipping to them earns nothing.
 */
export function motionAreas(cities: Iterable<MotionCity>, view: Area, ringed: ReadonlySet<number>): Area[] | null {
  const areas: Area[] = [];
  let covered = 0;
  for (const city of cities) {
    if (city.hidden) continue;
    if (!ringed.has(city.taskNumber) && !city.states.some((state) => STIRRING.has(state))) continue;
    const area = {
      x0: city.pos.x - CITY_MOTION_REACH.left,
      y0: city.pos.y - CITY_MOTION_REACH.top,
      x1: city.pos.x + CITY_MOTION_REACH.right,
      y1: city.pos.y + CITY_MOTION_REACH.bottom,
    };
    const over =
      Math.max(0, Math.min(area.x1, view.x1) - Math.max(area.x0, view.x0)) *
      Math.max(0, Math.min(area.y1, view.y1) - Math.max(area.y0, view.y0));
    if (!over) continue;
    covered += over;
    areas.push(area);
  }
  return covered > 0.5 * (view.x1 - view.x0) * (view.y1 - view.y0) ? null : areas;
}
