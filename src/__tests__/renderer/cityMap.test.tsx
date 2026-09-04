import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { CityMap } from '../../components/citymap/CityMap';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore, DEFAULT_DISPLAY_STATE, type TerminalDisplayState } from '../../stores/terminalStore';
import { useCityMapStore } from '../../stores/cityMapStore';
import type { Project, TaskWithWorkspace } from '../../types';

vi.mock('electron-log/renderer', () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../components/terminal/terminalActions', () => ({
  addProjectTerminal: vi.fn().mockResolvedValue(true),
  reconnectOrphanedSessions: vi.fn().mockResolvedValue(undefined),
  closeProjectTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  openWorktreeEditor: vi.fn(),
}));
vi.mock('../../components/terminal/terminalReact', () => ({
  terminalInstances: new Map(),
}));
// The drawer hosts the real header and body in the app; here only that it
// opens on the right terminal is the map's own behaviour.
vi.mock('../../components/terminal/TerminalHeader', () => ({
  TerminalHeader: ({ ptyId }: { ptyId: string }) => <div data-testid="drawer-header">{ptyId}</div>,
}));
vi.mock('../../components/terminal/TerminalBody', () => ({
  TerminalBody: ({ ptyId }: { ptyId: string }) => <div data-testid="drawer-body">{ptyId}</div>,
}));

const project: Project = { path: '/work/alpha', name: 'Alpha' };

function display(over: Partial<TerminalDisplayState> & { ptyId: string }): TerminalDisplayState {
  return { ...DEFAULT_DISPLAY_STATE, projectPath: project.path, ...over } as TerminalDisplayState;
}

function task(over: Partial<TaskWithWorkspace> & { taskNumber: number }): TaskWithWorkspace {
  return { name: `Task ${over.taskNumber}`, status: 'in_progress', createdAt: '2026-07-01T00:00:00.000Z', ...over };
}

beforeEach(() => {
  // jsdom draws nothing: the map's canvas stays blank and its observer inert.
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never;
  HTMLElement.prototype.setPointerCapture = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;

  useCityMapStore.setState({ byProject: {}, openPtyId: {}, selection: {} });
  useAppStore.setState({ projects: [project], activeView: 'project', activeProjectPath: project.path });
  useProjectStore.setState({
    tasks: [
      task({
        taskNumber: 7,
        name: 'Seven',
        prompt: 'Wire the kiro flags',
        worktreePath: '/wt/seven-7',
        branch: 'seven-7',
      }),
      task({ taskNumber: 9, name: 'Nine', status: 'in_review' }),
      task({ taskNumber: 11, name: 'Eleven', status: 'todo' }),
      task({ taskNumber: 12, name: 'Twelve', status: 'done' }),
    ],
    availableSandboxProviders: [],
    toasts: [],
  });
  useTerminalStore.setState({
    terminalsByProject: { [project.path]: ['alpha-1', 'alpha-7', 'alpha-7b'] },
    displayStates: {
      'alpha-1': display({ ptyId: 'alpha-1', label: 'Loose shell' }),
      'alpha-7': display({ ptyId: 'alpha-7', label: 'Wire kiro flags', taskId: 7, summaryType: 'ready' }),
      'alpha-7b': display({ ptyId: 'alpha-7b', lastOscTitle: 'Fix hook tests', taskId: 7, summaryType: 'thinking' }),
    },
    activeIndices: { [project.path]: 0 },
  });
  vi.mocked(window.api.globalSettings.get).mockResolvedValue(undefined as never);
  vi.mocked(window.api.globalSettings.set).mockClear();
});

describe('the city map', () => {
  test('founds a city per task, a site per task terminal, and opens the terminal behind a site', async () => {
    render(<CityMap projectPath={project.path} />);

    // Every task gets a city, listed under its status; the loose shell is counted, not placed.
    await screen.findByTestId('city-row-7');
    const sidebar = screen.getByLabelText('Cities');
    for (const n of [7, 9, 11, 12]) expect(within(sidebar).getByTestId(`city-row-${n}`)).toBeTruthy();
    expect(sidebar.textContent).toContain('1 terminal outside any ticket');
    expect(sidebar.textContent).toContain('waiting for you');

    await waitFor(() => {
      const plot = useCityMapStore.getState().byProject[project.path]?.cities[7];
      expect(plot?.lots).toEqual({ 'alpha-7': 0, 'alpha-7b': 1 });
    });
    // Two cities never share a lot on the map.
    const cities = useCityMapStore.getState().byProject[project.path].cities;
    const positions = Object.values(cities).map((c) => `${c.pos.x},${c.pos.y}`);
    expect(new Set(positions).size).toBe(4);

    // The city's inspector shows the ticket and its sites.
    fireEvent.click(screen.getByTestId('city-row-7'));
    const inspector = await screen.findByTestId('city-inspector');
    expect((within(inspector).getByLabelText('Ticket name') as HTMLInputElement).value).toBe('Seven');
    expect(inspector.textContent).toContain('Wire the kiro flags');
    expect(within(inspector).getByTestId('site-row-alpha-7').textContent).toContain('Waiting for you');
    expect(within(inspector).getByTestId('site-row-alpha-7b').textContent).toContain('Fix hook tests');
    expect(within(inspector).getByTestId('site-row-alpha-7b').textContent).toContain('Agent working');

    // A site opens its terminal in the drawer; hiding the drawer keeps the selection.
    fireEvent.click(screen.getByTestId('site-row-alpha-7b'));
    const drawer = await screen.findByTestId('terminal-drawer');
    expect(drawer.textContent).toContain('alpha-7b');
    expect(screen.getByTestId('site-inspector')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Hide terminal'));
    expect(screen.queryByTestId('terminal-drawer')).toBeNull();

    // Positions and lots persist under the project.
    await waitFor(() => {
      const saved = vi
        .mocked(window.api.globalSettings.set)
        .mock.calls.filter(([key]) => key === 'citymap:/work/alpha')
        .at(-1);
      expect(saved).toBeDefined();
      const state = JSON.parse(saved![1] as string);
      expect(Object.keys(state.cities).sort()).toEqual(['11', '12', '7', '9']);
      expect(state.cities[7].lots).toEqual({ 'alpha-7': 0, 'alpha-7b': 1 });
    });

    // A terminal that finished and closed leaves a building; one closed mid-work frees its lot.
    useTerminalStore.getState().updateDisplay('alpha-7b', { summaryType: 'success' });
    await waitFor(() => expect(screen.getByTestId('site-inspector').textContent).toContain('Finished'));
    useTerminalStore.getState().removeTerminal('alpha-7b');
    useTerminalStore.getState().removeTerminal('alpha-7');
    await waitFor(() => {
      const plot = useCityMapStore.getState().byProject[project.path].cities[7];
      expect(plot.lots).toEqual({});
      expect(plot.built).toEqual([1]);
    });
  });

  test('a dragged city lands where the pointer let go, and stays there', async () => {
    render(<CityMap projectPath={project.path} />);
    await screen.findByTestId('city-row-7');
    await waitFor(() => expect(useCityMapStore.getState().byProject[project.path]?.cities[7]).toBeDefined());
    const canvas = screen.getByLabelText('Map of tasks as cities');
    const start = useCityMapStore.getState().byProject[project.path].cities[7].pos;

    // The stubbed observer leaves the canvas at 0×0, so screen (0,0) is the
    // camera centre, which the first city is founded on.
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'offsetX', { value: x });
      Object.defineProperty(event, 'offsetY', { value: y });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      canvas.dispatchEvent(event);
    };
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 45, 18);
    pointer('pointermove', 90, 36);
    pointer('pointerup', 90, 36);

    const zoom = useCityMapStore.getState().byProject[project.path].viewport.zoom;
    const moved = useCityMapStore.getState().byProject[project.path].cities[7].pos;
    expect(moved.x).toBeCloseTo(start.x + 90 / zoom, 5);
    expect(moved.y).toBeCloseTo(start.y + 36 / zoom, 5);
    await waitFor(() => {
      const saved = vi
        .mocked(window.api.globalSettings.set)
        .mock.calls.filter(([key]) => key === 'citymap:/work/alpha')
        .at(-1);
      expect(JSON.parse(saved![1] as string).cities[7].pos).toEqual(moved);
    });
  });
});
