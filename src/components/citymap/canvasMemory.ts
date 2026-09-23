export interface CanvasCache {
  name: string;
  stats(): { entries: number; bytes: number };
}

/** Every offscreen canvas cache alive, so the memory report can count what they hold. */
export const canvasCaches = new Set<CanvasCache>();

/**
 * A canvas this size or larger is GPU-backed, and its texture is held until the
 * element is collected, which a small, quiet JS heap leaves for a long time.
 * Sizing it to nothing hands the texture back at once.
 */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}
