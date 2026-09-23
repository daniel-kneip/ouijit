import { app } from 'electron';
import { freemem, totalmem } from 'node:os';
import { getActiveSessionCount } from './ptyManager';

export interface ProcessMemory {
  type: string;
  pid: number;
  name?: string;
  /** Resident memory in MB. */
  residentMb: number;
  peakResidentMb: number;
  cpuPercent: number;
}

export interface MemoryReport {
  at: string;
  electron: string;
  platform: string;
  processes: ProcessMemory[];
  main: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number };
  ptys: number;
  system: { totalMb: number; freeMb: number };
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** Resident memory of every process the app runs, as the OS counts it, next to what the main process's heap holds. */
export function memoryReport(): MemoryReport {
  const usage = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    electron: process.versions.electron ?? 'unknown',
    platform: `${process.platform} ${process.arch}`,
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      name: m.name,
      residentMb: Math.round(m.memory.workingSetSize / 1024),
      peakResidentMb: Math.round(m.memory.peakWorkingSetSize / 1024),
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    })),
    main: {
      rssMb: mb(usage.rss),
      heapUsedMb: mb(usage.heapUsed),
      externalMb: mb(usage.external),
      arrayBuffersMb: mb(usage.arrayBuffers),
    },
    ptys: getActiveSessionCount(),
    system: { totalMb: mb(totalmem()), freeMb: mb(freemem()) },
  };
}
