import { sectionKey, type ResolvedGroup } from '../../lens/lens';

export interface DocumentSection {
  path: string;
  group?: string;
}

/**
 * The section after `section` in the order the document lays its files out:
 * the lens's parts and their slices when one is on, the file order otherwise.
 * Null after the last one.
 */
export function sectionAfter(
  order: readonly string[],
  groups: ResolvedGroup[] | null | undefined,
  section: string,
): DocumentSection | null {
  const sections: DocumentSection[] = groups
    ? groups.flatMap((group) => group.slices.map((slice) => ({ path: slice.path, group: group.id })))
    : order.map((path) => ({ path }));
  const at = sections.findIndex((s) => sectionKey(s.group, s.path) === section);
  return at === -1 ? null : (sections[at + 1] ?? null);
}
