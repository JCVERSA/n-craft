import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { PixelFrame, PixelMatrix } from './pixelStudio.ts';

function drawPixelMatrix(
  context: CanvasRenderingContext2D,
  matrix: PixelMatrix,
  scale: number,
  background: string | null,
  offsetX = 0,
): void {
  const size = matrix.length;
  if (background) {
    context.fillStyle = background;
    context.fillRect(offsetX, 0, size * scale, size * scale);
  } else {
    context.clearRect(offsetX, 0, size * scale, size * scale);
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = matrix[y]?.[x];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(offsetX + x * scale, y * scale, scale, scale);
    }
  }
}

function pixelCanvas(matrix: PixelMatrix, scale: number, background: string | null): HTMLCanvasElement {
  if (!Number.isSafeInteger(scale) || scale < 1 || matrix.length < 1 || matrix.length > 64) {
    throw new Error('Dimensions de sprite invalides.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = matrix.length * scale;
  canvas.height = matrix.length * scale;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D indisponible.');
  context.imageSmoothingEnabled = false;
  drawPixelMatrix(context, matrix, scale, background);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Impossible de convertir le dessin.'));
    }, type);
  });
}

export async function exportPixelPng(matrix: PixelMatrix, scale = 8): Promise<Blob> {
  const canvas = pixelCanvas(matrix, scale, null);
  try {
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function exportPixelSpritesheet(frames: PixelFrame[], scale = 8): Promise<Blob> {
  if (frames.length === 0) throw new Error('Aucune image à exporter.');
  const size = frames[0].pixels.length;
  if (!Number.isSafeInteger(scale) || scale < 1 || frames.some((frame) => frame.pixels.length !== size)) {
    throw new Error('Les images de l’animation n’ont pas les mêmes dimensions.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = size * scale * frames.length;
  canvas.height = size * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponible.');
  context.imageSmoothingEnabled = false;
  frames.forEach((frame, index) => drawPixelMatrix(context, frame.pixels, scale, null, index * size * scale));
  try {
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function exportPixelGif(frames: PixelFrame[], fps: number, scale = 6): Promise<Blob> {
  if (frames.length < 2) throw new Error('Ajoute au moins deux images pour créer un GIF.');
  const size = frames[0].pixels.length;
  if (!Number.isSafeInteger(scale) || scale < 1 || frames.some((frame) => frame.pixels.length !== size)) {
    throw new Error('Les images de l’animation n’ont pas les mêmes dimensions.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = size * scale;
  canvas.height = size * scale;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D indisponible.');
  context.imageSmoothingEnabled = false;
  const gif = GIFEncoder();

  try {
    for (const frame of frames) {
      drawPixelMatrix(context, frame.pixels, scale, null);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const palette = quantize(image.data, 256, { format: 'rgba4444', oneBitAlpha: true });
      const transparentIndex = palette.findIndex((color) => color[3] === 0);
      const indexedPixels = applyPalette(image.data, palette, 'rgba4444');
      gif.writeFrame(indexedPixels, canvas.width, canvas.height, {
        palette,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
        delay: Math.max(50, frame.durationMs || Math.round(1_000 / Math.max(1, fps))),
        repeat: 0,
      });
    }
    gif.finish();
    const bytes = gif.bytes();
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return new Blob([copy.buffer], { type: 'image/gif' });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function downloadPixelFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
