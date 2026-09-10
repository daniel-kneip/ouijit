import { terminalInstances } from '../components/terminal/terminalReact';

export interface RendererMemory {
  jsHeapMb: number | null;
  domNodes: number;
  canvases: { count: number; totalMb: number; largest: string[] };
  images: number;
  webviews: number;
  terminals: { count: number; attached: number; bufferLines: number };
}

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number };
}

/** What this window holds outside the JS heap: bitmaps, DOM and terminal buffers, which a heap snapshot does not count. */
export function rendererMemory(): RendererMemory {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const sized = canvases
    .map((c) => ({
      label: `${c.width}×${c.height}${c.dataset.testid ? ` ${c.dataset.testid}` : ''}`,
      bytes: c.width * c.height * 4,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  let bufferLines = 0;
  let attached = 0;
  for (const inst of terminalInstances.values()) {
    bufferLines += inst.xterm.buffer.active.length;
    if (inst.xterm.element?.isConnected) attached += 1;
  }
  const memory = (performance as PerformanceWithMemory).memory;
  return {
    jsHeapMb: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null,
    domNodes: document.getElementsByTagName('*').length,
    canvases: {
      count: canvases.length,
      totalMb: Math.round(sized.reduce((sum, c) => sum + c.bytes, 0) / 1024 / 1024),
      largest: sized.slice(0, 5).map((c) => `${c.label} (${Math.round(c.bytes / 1024 / 1024)} MB)`),
    },
    images: document.images.length,
    webviews: document.querySelectorAll('webview').length,
    terminals: { count: terminalInstances.size, attached, bufferLines },
  };
}
