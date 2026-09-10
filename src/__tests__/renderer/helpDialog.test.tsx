import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HelpDialog } from '../../components/dialogs/HelpDialog';

describe('the help dialog', () => {
  test('copies a memory report that pairs every process with what the window holds', async () => {
    vi.mocked(window.api.health.memory).mockResolvedValue({
      at: '2026-09-10T10:00:00.000Z',
      electron: '39.8.8',
      platform: 'darwin arm64',
      processes: [{ type: 'GPU', pid: 42, residentMb: 300, peakResidentMb: 320, cpuPercent: 1 }],
      main: { rssMb: 120, heapUsedMb: 40, externalMb: 5, arrayBuffersMb: 1 },
      ptys: 3,
      system: { totalMb: 16384, freeMb: 2048 },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 500;
    document.body.appendChild(canvas);

    render(<HelpDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByText('Copy memory report'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const report = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(report.processes[0]).toMatchObject({ type: 'GPU', residentMb: 300 });
    expect(report.window.canvases).toMatchObject({ count: 1, totalMb: 2 });
    expect(report.window.canvases.largest[0]).toContain('1000×500');
    expect(report.window.terminals).toEqual({ count: 0, attached: 0, bufferLines: 0 });
    expect(await screen.findByText('Copied')).toBeTruthy();
    canvas.remove();
  });
});
