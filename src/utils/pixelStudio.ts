export const PIXEL_STUDIO_STORAGE_KEY = 'ncraft.pixel-studio.project.v1';
export const PIXEL_STUDIO_GRID_SIZES = [16, 32, 64] as const;
export type PixelGridSize = (typeof PIXEL_STUDIO_GRID_SIZES)[number];
export type PixelMatrix = string[][];
export type PixelPaletteId = 'minecraft' | 'pico8' | 'gameboy' | 'nes';

export interface PixelFrame {
  id: string;
  pixels: PixelMatrix;
  durationMs: number;
}

export interface PixelStudioProject {
  schemaVersion: 1;
  name: string;
  gridSize: PixelGridSize;
  paletteId: PixelPaletteId;
  paletteColors: string[];
  selectedColor: string;
  fps: number;
  activeFrameIndex: number;
  frames: PixelFrame[];
  updatedAt: number;
}

export const PIXEL_STUDIO_PALETTES: Record<PixelPaletteId, { label: string; colors: string[] }> = {
  minecraft: {
    label: 'Minecraft',
    colors: ['#7FB238', '#976D4D', '#707070', '#5CDBD5', '#FAEE4D', '#B02E26', '#3C44AA', '#1D1D21', '#F7E9A3', '#8932B8', '#FFFFFF', '#0E0E11'],
  },
  pico8: {
    label: 'PICO-8',
    colors: ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8', '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'],
  },
  gameboy: {
    label: 'Game Boy',
    colors: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
  },
  nes: {
    label: 'NES',
    colors: ['#7C7C7C', '#0000FC', '#0000BC', '#4428BC', '#940084', '#A80020', '#A81000', '#881400', '#503000', '#007800', '#006800', '#005800', '#004058', '#000000', '#FFFFFF', '#FC9838'],
  },
};

const MAX_PROJECT_NAME = 64;
const MAX_FRAMES = 12;
const MAX_PALETTE_COLORS = 32;

export function isPixelGridSize(value: unknown): value is PixelGridSize {
  return typeof value === 'number' && PIXEL_STUDIO_GRID_SIZES.includes(value as PixelGridSize);
}

export function isPixelColor(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^#[\da-f]{6}$/i.test(value));
}

export function createEmptyPixelMatrix(size: PixelGridSize): PixelMatrix {
  return Array.from({ length: size }, () => Array<string>(size).fill(''));
}

export function clonePixelMatrix(matrix: PixelMatrix): PixelMatrix {
  return matrix.map((row) => [...row]);
}

export function parsePixelMatrix(value: unknown, size: PixelGridSize): PixelMatrix | null {
  if (!Array.isArray(value) || value.length !== size) return null;
  const matrix: PixelMatrix = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== size || !row.every(isPixelColor)) return null;
    matrix.push(row.map((color) => (color as string).toUpperCase()));
  }
  return matrix;
}

export function resizePixelMatrix(matrix: PixelMatrix, targetSize: PixelGridSize): PixelMatrix {
  const sourceSize = matrix.length;
  if (!isPixelGridSize(sourceSize) || !matrix.every((row) => Array.isArray(row) && row.length === sourceSize)) {
    return createEmptyPixelMatrix(targetSize);
  }
  if (sourceSize === targetSize) return clonePixelMatrix(matrix);
  return Array.from({ length: targetSize }, (_, y) =>
    Array.from({ length: targetSize }, (_, x) => {
      const sourceY = Math.min(sourceSize - 1, Math.floor((y * sourceSize) / targetSize));
      const sourceX = Math.min(sourceSize - 1, Math.floor((x * sourceSize) / targetSize));
      const color = matrix[sourceY]?.[sourceX];
      return isPixelColor(color) ? color : '';
    }),
  );
}

export function fillPixelRegion(matrix: PixelMatrix, x: number, y: number, color: string): PixelMatrix {
  const size = matrix.length;
  if (!isPixelGridSize(size) || !matrix.every((row) => Array.isArray(row) && row.length === size)) return matrix;
  if (!isPixelColor(color) || x < 0 || y < 0 || x >= size || y >= size) return matrix;
  const targetColor = matrix[y][x];
  if (targetColor === color) return matrix;

  const next = clonePixelMatrix(matrix);
  const pending: Array<[number, number]> = [[x, y]];
  let cursor = 0;
  while (cursor < pending.length) {
    const [currentX, currentY] = pending[cursor++];
    if (next[currentY][currentX] !== targetColor) continue;
    next[currentY][currentX] = color;
    if (currentX > 0) pending.push([currentX - 1, currentY]);
    if (currentX + 1 < size) pending.push([currentX + 1, currentY]);
    if (currentY > 0) pending.push([currentX, currentY - 1]);
    if (currentY + 1 < size) pending.push([currentX, currentY + 1]);
  }
  return next;
}

export function createPixelStudioProject(): PixelStudioProject {
  return {
    schemaVersion: 1,
    name: 'Nouvelle création',
    gridSize: 16,
    paletteId: 'minecraft',
    paletteColors: [...PIXEL_STUDIO_PALETTES.minecraft.colors],
    selectedColor: '#5CDBD5',
    fps: 4,
    activeFrameIndex: 0,
    frames: [{ id: 'frame-1', pixels: createEmptyPixelMatrix(16), durationMs: 250 }],
    updatedAt: Date.now(),
  };
}

export function parsePixelStudioProject(value: unknown): PixelStudioProject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !isPixelGridSize(input.gridSize)) return null;
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > MAX_PROJECT_NAME) return null;
  if (typeof input.paletteId !== 'string' || !Object.hasOwn(PIXEL_STUDIO_PALETTES, input.paletteId)) return null;
  if (!Array.isArray(input.paletteColors) || input.paletteColors.length === 0 || input.paletteColors.length > MAX_PALETTE_COLORS) return null;
  if (!input.paletteColors.every(isPixelColor) || !input.paletteColors.every((color) => color !== '')) return null;
  if (!isPixelColor(input.selectedColor) || input.selectedColor === '') return null;
  if (!Number.isInteger(input.fps) || (input.fps as number) < 1 || (input.fps as number) > 20) return null;
  if (!Array.isArray(input.frames) || input.frames.length === 0 || input.frames.length > MAX_FRAMES) return null;

  const frames: PixelFrame[] = [];
  const frameIds = new Set<string>();
  for (const item of input.frames) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const frame = item as Record<string, unknown>;
    if (typeof frame.id !== 'string' || frame.id.length === 0 || frame.id.length > 80 || frameIds.has(frame.id)) return null;
    frameIds.add(frame.id);
    if (!Number.isInteger(frame.durationMs) || (frame.durationMs as number) < 40 || (frame.durationMs as number) > 2_000) return null;
    if (!Array.isArray(frame.pixels) || frame.pixels.length !== input.gridSize) return null;
    const pixels: PixelMatrix = [];
    for (const row of frame.pixels) {
      if (!Array.isArray(row) || row.length !== input.gridSize || !row.every(isPixelColor)) return null;
      pixels.push(row.map((color) => color.toUpperCase()));
    }
    frames.push({ id: frame.id, pixels, durationMs: frame.durationMs as number });
  }

  const paletteColors = Array.from(new Set((input.paletteColors as string[]).map((color) => color.toUpperCase())));
  const selectedColor = input.selectedColor.toUpperCase();
  if (!paletteColors.includes(selectedColor)) paletteColors.unshift(selectedColor);
  if (paletteColors.length > MAX_PALETTE_COLORS) paletteColors.length = MAX_PALETTE_COLORS;

  return {
    schemaVersion: 1,
    name: input.name.trim(),
    gridSize: input.gridSize,
    paletteId: input.paletteId as PixelPaletteId,
    paletteColors,
    selectedColor,
    fps: input.fps as number,
    activeFrameIndex: Number.isInteger(input.activeFrameIndex)
      ? Math.max(0, Math.min(frames.length - 1, input.activeFrameIndex as number))
      : 0,
    frames,
    updatedAt: Number.isSafeInteger(input.updatedAt) ? input.updatedAt as number : Date.now(),
  };
}

export function restorePixelStudioProject(): PixelStudioProject {
  try {
    const raw = window.localStorage.getItem(PIXEL_STUDIO_STORAGE_KEY);
    if (!raw || raw.length > 2_000_000) return createPixelStudioProject();
    return parsePixelStudioProject(JSON.parse(raw)) ?? createPixelStudioProject();
  } catch {
    return createPixelStudioProject();
  }
}
