import { useCallback, useEffect, useState } from 'react';
import type { HarnessUsage, UsageReading } from '../../types';
import { formatRelativeTime } from '../../utils/formatDate';

const REFRESH_EVERY = 5 * 60 * 1000;

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 10e6 ? 2 : 1)}M`;
}

export function usageShare(reading: UsageReading): number | null {
  if (reading.unit === 'percent') return Math.max(0, Math.min(1, reading.used / 100));
  if (reading.limit) return Math.max(0, Math.min(1, reading.used / reading.limit));
  return null;
}

export function usageText(reading: UsageReading): string {
  if (reading.unit === 'percent') return `${Math.round(reading.used)}%`;
  if (reading.limit) return `${formatTokens(reading.used)} / ${formatTokens(reading.limit)}`;
  return formatTokens(reading.used);
}

function shareColour(share: number): string {
  if (share >= 0.9) return 'var(--color-error)';
  if (share >= 0.7) return 'var(--color-ansi-yellow)';
  return 'var(--color-accent)';
}

/** Every harness with a usage command, each pill showing what the command last reported; a click asks again. */
export function HarnessUsageBar() {
  const [usage, setUsage] = useState<HarnessUsage[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setUsage(await window.api.harness.usage());
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_EVERY);
    return () => clearInterval(timer);
  }, [refresh]);

  if (usage.length === 0) return null;
  return (
    <div
      className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5"
      data-testid="harness-usage"
    >
      {usage.map((entry) => {
        const share = entry.reading ? usageShare(entry.reading) : null;
        const detail = [
          entry.reading?.label,
          entry.error,
          `Asked ${formatRelativeTime(new Date(entry.at))}${busy ? ', asking again' : ''} — click to ask again`,
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <button
            key={entry.harnessId}
            type="button"
            className={`relative overflow-hidden flex items-center gap-2 pl-2.5 pr-3 py-1 rounded-full border text-[11px] ${entry.error ? 'border-error/60 text-error' : 'border-border text-text-secondary hover:text-text-primary'}`}
            style={{ background: 'var(--color-surface-raised)', boxShadow: 'var(--shadow-panel)' }}
            onClick={() => void refresh()}
            title={detail}
            data-testid={`harness-usage-${entry.harnessId}`}
          >
            <span className="font-medium text-text-primary">{entry.name}</span>
            <span className="font-mono tabular-nums">
              {entry.reading ? usageText(entry.reading) : entry.error ? 'unavailable' : '…'}
            </span>
            {share != null && (
              <span
                className="absolute left-0 bottom-0 h-[3px] rounded-r-full"
                style={{ width: `${share * 100}%`, background: shareColour(share) }}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
