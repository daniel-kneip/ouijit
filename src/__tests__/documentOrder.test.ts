import { describe, test, expect } from 'vitest';
import { sectionAfter } from '../components/diff/documentOrder';
import type { ResolvedGroup } from '../lens/lens';

describe('the section after one in the document', () => {
  test('follows the file order flat, and the parts and slices under a lens', () => {
    const order = ['a.ts', 'b.ts', 'c.ts'];
    expect(sectionAfter(order, null, 'a.ts')).toEqual({ path: 'b.ts' });
    expect(sectionAfter(order, null, 'c.ts')).toBeNull();
    expect(sectionAfter(order, null, 'nope.ts')).toBeNull();

    const groups = [
      {
        id: 'g1',
        title: 'First',
        slices: [
          { path: 'c.ts', hunks: [] },
          { path: 'a.ts', hunks: [] },
        ],
      },
      { id: 'g2', title: 'Second', slices: [{ path: 'a.ts', hunks: [] }] },
    ] as unknown as ResolvedGroup[];
    expect(sectionAfter(order, groups, 'g1:c.ts')).toEqual({ path: 'a.ts', group: 'g1' });
    expect(sectionAfter(order, groups, 'g1:a.ts')).toEqual({ path: 'a.ts', group: 'g2' });
    expect(sectionAfter(order, groups, 'g2:a.ts')).toBeNull();
  });
});
