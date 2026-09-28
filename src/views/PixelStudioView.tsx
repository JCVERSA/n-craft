import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  Brush,
  Download,
  Eraser,
  FileJson,
  Film,
  Grid2X2,
  Image as ImageIcon,
  Loader2,
  PaintBucket,
  Pause,
  Pipette,
  Play,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { NetherCard } from '../components/NetherCard.tsx';
import {
  PIXEL_STUDIO_GRID_SIZES,
  PIXEL_STUDIO_PALETTES,
  PIXEL_STUDIO_STORAGE_KEY,
  clonePixelMatrix,
  createEmptyPixelMatrix,
  fillPixelRegion,
  isPixelColor,
  parsePixelMatrix,
  restorePixelStudioProject,
  resizePixelMatrix,
  parsePixelStudioProject,
  type PixelFrame,
  type PixelGridSize,
  type PixelMatrix,
  type PixelPaletteId,
  type PixelStudioProject,
} from '../utils/pixelStudio.ts';
import { downloadPixelFile, exportPixelGif, exportPixelPng, exportPixelSpritesheet } from '../utils/pixelStudioExport.ts';

export type PixelStudioToastTone = 'success' | 'warning' | 'error' | 'info';

interface PixelStudioViewProps {
  onNotify: (tone: PixelStudioToastTone, title: string, description: string) => void;
}

type PixelTool = 'pencil' | 'eraser' | 'bucket' | 'picker';
type AIState = 'loading' | 'ready' | 'unavailable';

interface PixelStudioAIStatus {
  available: boolean;
  primaryAvailable: boolean;
  fallbackAvailable: boolean;
  fallbackOrder: ['NVIDIA NIM', 'Gemini'];
}

interface PixelStroke {
  pointerId: number;
  pixels: PixelMatrix;
  before: PixelMatrix;
  value: string;
  lastPoint: { x: number; y: number } | null;
}

function lineCells(fromX: number, fromY: number, toX: number, toY: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let x = fromX;
  let y = fromY;
  const dx = Math.abs(toX - fromX);
  const sx = fromX < toX ? 1 : -1;
  const dy = -Math.abs(toY - fromY);
  const sy = fromY < toY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    points.push({ x, y });
    if (x === toX && y === toY) break;
    const doubledError = 2 * error;
    if (doubledError >= dy) { error += dy; x += sx; }
    if (doubledError <= dx) { error += dx; y += sy; }
  }
  return points;
}

const TOOL_OPTIONS: Array<{ id: PixelTool; label: string; shortcut: string; icon: LucideIcon }> = [
  { id: 'pencil', label: 'Crayon', shortcut: 'P', icon: Brush },
  { id: 'eraser', label: 'Gomme', shortcut: 'E', icon: Eraser },
  { id: 'bucket', label: 'Remplissage', shortcut: 'B', icon: PaintBucket },
  { id: 'picker', label: 'Pipette', shortcut: 'I', icon: Pipette },
];

const ANIMATION_TYPES = [
  { value: 'shimmer', label: 'Scintillement' },
  { value: 'flame', label: 'Flamme' },
  { value: 'portal', label: 'Portail' },
  { value: 'bounce', label: 'Rebond' },
  { value: 'wave', label: 'Vague' },
];

function pixelMatrixEqual(left: PixelMatrix, right: PixelMatrix): boolean {
  return left.length === right.length && left.every((row, index) => row.length === right[index]?.length && row.every((color, x) => color === right[index][x]));
}

function newFrameId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function safeFileName(value: string): string {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'pixel-art';
}

function pixelColors(matrix: PixelMatrix): string[] {
  return Array.from(new Set(matrix.flat().filter(Boolean)));
}

function matrixFromApi(value: unknown, size: PixelGridSize): PixelMatrix {
  const parsed = parsePixelMatrix(value, size);
  if (!parsed) throw new Error('Le modèle a retourné une matrice incorrecte. Réessaie.');
  return parsed;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

function saveProjectJson(project: PixelStudioProject): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadPixelFile(`${safeFileName(project.name)}.ncraft-pixel.json`, blob);
}

export default function PixelStudioView({ onNotify }: PixelStudioViewProps) {
  const [project, setProject] = useState<PixelStudioProject>(() => restorePixelStudioProject());
  const projectRef = useRef(project);
  const activeFrame = project.frames[project.activeFrameIndex] ?? project.frames[0];
  const matrix = activeFrame?.pixels ?? createEmptyPixelMatrix(project.gridSize);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const strokeRef = useRef<PixelStroke | null>(null);
  const historyRef = useRef<PixelMatrix[]>([clonePixelMatrix(matrix)]);
  const historyIndexRef = useRef(0);
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });
  const [tool, setTool] = useState<PixelTool>('pencil');
  const [focusedCell, setFocusedCell] = useState({ x: 0, y: 0 });
  const [customColor, setCustomColor] = useState('#FFB875');
  const [isPlaying, setIsPlaying] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [animationType, setAnimationType] = useState('shimmer');
  const [aiFrameCount, setAiFrameCount] = useState(3);
  const [aiBusy, setAiBusy] = useState<'sprite' | 'animation' | null>(null);
  const [aiStatus, setAiStatus] = useState<AIState>('loading');
  const [aiProviders, setAiProviders] = useState<PixelStudioAIStatus | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [exportBusy, setExportBusy] = useState<'png' | 'spritesheet' | 'gif' | null>(null);

  const updateProject = useCallback((update: (current: PixelStudioProject) => PixelStudioProject, touch = true) => {
    const current = projectRef.current;
    const next = update(current);
    const result = touch ? { ...next, updatedAt: Date.now() } : next;
    projectRef.current = result;
    setProject(result);
  }, []);

  const resetHistory = useCallback((nextMatrix: PixelMatrix) => {
    historyRef.current = [clonePixelMatrix(nextMatrix)];
    historyIndexRef.current = 0;
    setHistoryAvailability({ undo: false, redo: false });
  }, []);

  const recordHistory = useCallback((nextMatrix: PixelMatrix) => {
    const currentHistory = historyRef.current;
    const currentIndex = historyIndexRef.current;
    if (currentHistory[currentIndex] && pixelMatrixEqual(currentHistory[currentIndex], nextMatrix)) return;
    const nextHistory = currentHistory.slice(0, currentIndex + 1);
    nextHistory.push(clonePixelMatrix(nextMatrix));
    if (nextHistory.length > 48) nextHistory.shift();
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    setHistoryAvailability({ undo: nextHistory.length > 1, redo: false });
  }, []);

  const updateActivePixels = useCallback((nextMatrix: PixelMatrix, touch = true) => {
    updateProject((current) => ({
      ...current,
      frames: current.frames.map((frame, index) => index === current.activeFrameIndex ? { ...frame, pixels: nextMatrix } : frame),
    }), touch);
  }, [updateProject]);

  const commitMatrix = useCallback((nextMatrix: PixelMatrix) => {
    if (pixelMatrixEqual(matrix, nextMatrix)) return;
    updateActivePixels(nextMatrix);
    recordHistory(nextMatrix);
  }, [matrix, recordHistory, updateActivePixels]);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    const next = historyRef.current[historyIndexRef.current];
    if (!next) return;
    updateActivePixels(clonePixelMatrix(next));
    setHistoryAvailability({ undo: historyIndexRef.current > 0, redo: true });
  }, [updateActivePixels]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    if (!next) return;
    updateActivePixels(clonePixelMatrix(next));
    setHistoryAvailability({ undo: true, redo: historyIndexRef.current < historyRef.current.length - 1 });
  }, [updateActivePixels]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PIXEL_STUDIO_STORAGE_KEY, JSON.stringify(project));
        setStorageAvailable(true);
      } catch {
        setStorageAvailable(false);
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [project]);

  useEffect(() => () => {
    try {
      window.localStorage.setItem(PIXEL_STUDIO_STORAGE_KEY, JSON.stringify(projectRef.current));
    } catch {
      // The download formats remain available when browser storage is blocked or full.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/pixel-studio/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        const payload = await readJsonResponse(response);
        if (!response.ok) throw new Error('Statut IA indisponible.');
        if (alive) {
          setAiProviders(payload as unknown as PixelStudioAIStatus);
          setAiStatus(payload.available ? 'ready' : 'unavailable');
        }
      })
      .catch(() => {
        if (alive) {
          setAiProviders(null);
          setAiStatus('unavailable');
        }
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isPlaying || project.frames.length < 2) return undefined;
    const delay = Math.max(50, activeFrame?.durationMs ?? Math.round(1_000 / project.fps));
    const timer = window.setTimeout(() => {
      const current = projectRef.current;
      const nextIndex = (current.activeFrameIndex + 1) % current.frames.length;
      resetHistory(current.frames[nextIndex].pixels);
      updateProject((value) => ({ ...value, activeFrameIndex: nextIndex }), false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeFrame?.durationMs, isPlaying, project.activeFrameIndex, project.fps, project.frames.length, resetHistory, updateProject]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const cellSize = 16;
    canvas.width = project.gridSize * cellSize;
    canvas.height = project.gridSize * cellSize;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    for (let y = 0; y < project.gridSize; y += 1) {
      for (let x = 0; x < project.gridSize; x += 1) {
        const color = matrix[y]?.[x];
        if (!color) continue;
        context.fillStyle = color;
        context.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }
    context.strokeStyle = 'rgba(12, 9, 14, 0.45)';
    context.lineWidth = Math.max(0.75, cellSize / 18);
    context.beginPath();
    for (let position = 0; position <= project.gridSize; position += 1) {
      const offset = position * cellSize + 0.5;
      context.moveTo(offset, 0);
      context.lineTo(offset, canvas.height);
      context.moveTo(0, offset);
      context.lineTo(canvas.width, offset);
    }
    context.stroke();
    const focusCellSize = cellSize;
    context.strokeStyle = 'rgba(255, 248, 241, 0.95)';
    context.lineWidth = Math.max(1.5, cellSize / 8);
    context.strokeRect(focusedCell.x * focusCellSize + 1, focusedCell.y * focusCellSize + 1, focusCellSize - 2, focusCellSize - 2);
  }, [focusedCell, matrix, project.gridSize]);

  const getCanvasCell = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(projectRef.current.gridSize - 1, Math.floor(((event.clientX - rect.left) / rect.width) * projectRef.current.gridSize)));
    const y = Math.max(0, Math.min(projectRef.current.gridSize - 1, Math.floor(((event.clientY - rect.top) / rect.height) * projectRef.current.gridSize)));
    return { x, y };
  }, []);

  const applyStrokeAt = useCallback((x: number, y: number) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    if (stroke.lastPoint?.x === x && stroke.lastPoint.y === y) return;
    const from = stroke.lastPoint ?? { x, y };
    const next = clonePixelMatrix(stroke.pixels);
    let changed = false;
    for (const point of lineCells(from.x, from.y, x, y)) {
      if (next[point.y][point.x] === stroke.value) continue;
      next[point.y][point.x] = stroke.value;
      changed = true;
    }
    stroke.pixels = next;
    stroke.lastPoint = { x, y };
    if (changed) updateActivePixels(next);
  }, [updateActivePixels]);

  const applyToolAt = useCallback((x: number, y: number) => {
    const current = projectRef.current;
    const currentMatrix = current.frames[current.activeFrameIndex]?.pixels ?? createEmptyPixelMatrix(current.gridSize);
    if (tool === 'picker') {
      const picked = currentMatrix[y]?.[x];
      if (picked) updateProject((value) => ({ ...value, selectedColor: picked }));
      return;
    }
    const next = tool === 'bucket'
      ? fillPixelRegion(currentMatrix, x, y, current.selectedColor)
      : clonePixelMatrix(currentMatrix);
    if (tool === 'pencil') next[y][x] = current.selectedColor;
    if (tool === 'eraser') next[y][x] = '';
    commitMatrix(next);
  }, [commitMatrix, tool, updateProject]);

  const finishStroke = useCallback((pointerId?: number) => {
    const stroke = strokeRef.current;
    if (!stroke || (pointerId !== undefined && stroke.pointerId !== pointerId)) return;
    strokeRef.current = null;
    if (!pixelMatrixEqual(stroke.before, stroke.pixels)) recordHistory(stroke.pixels);
  }, [recordHistory]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setIsPlaying(false);
    event.currentTarget.focus({ preventScroll: true });
    const { x, y } = getCanvasCell(event);
    setFocusedCell({ x, y });
    if (tool === 'picker' || tool === 'bucket') {
      applyToolAt(x, y);
      return;
    }
    const currentMatrix = projectRef.current.frames[projectRef.current.activeFrameIndex]?.pixels ?? createEmptyPixelMatrix(projectRef.current.gridSize);
    const before = clonePixelMatrix(currentMatrix);
    strokeRef.current = {
      pointerId: event.pointerId,
      pixels: clonePixelMatrix(currentMatrix),
      before,
      value: tool === 'eraser' ? '' : projectRef.current.selectedColor,
      lastPoint: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    applyStrokeAt(x, y);
  }, [applyStrokeAt, applyToolAt, getCanvasCell, tool]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCell(event);
    setFocusedCell((current) => current.x === x && current.y === y ? current : { x, y });
    if (strokeRef.current?.pointerId !== event.pointerId) return;
    applyStrokeAt(x, y);
  }, [applyStrokeAt, getCanvasCell]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    finishStroke(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [finishStroke]);

  const handleCanvasKeyDown = useCallback((event: KeyboardEvent<HTMLCanvasElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    const next = { ...focusedCell };
    if (event.key === 'ArrowLeft') next.x = Math.max(0, next.x - 1);
    else if (event.key === 'ArrowRight') next.x = Math.min(project.gridSize - 1, next.x + 1);
    else if (event.key === 'ArrowUp') next.y = Math.max(0, next.y - 1);
    else if (event.key === 'ArrowDown') next.y = Math.min(project.gridSize - 1, next.y + 1);
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setIsPlaying(false);
      applyToolAt(focusedCell.x, focusedCell.y);
      return;
    } else {
      const shortcut = event.key.toLowerCase();
      const selectedTool = TOOL_OPTIONS.find((option) => option.shortcut.toLowerCase() === shortcut);
      if (selectedTool) {
        event.preventDefault();
        setTool(selectedTool.id);
      }
      return;
    }
    event.preventDefault();
    setFocusedCell(next);
  }, [applyToolAt, focusedCell, project.gridSize, redo, setIsPlaying, undo]);

  const chooseFrame = useCallback((index: number) => {
    setIsPlaying(false);
    const next = projectRef.current.frames[index]?.pixels;
    if (!next) return;
    updateProject((current) => ({ ...current, activeFrameIndex: index }));
    resetHistory(next);
  }, [resetHistory, updateProject]);

  const addFrame = useCallback((duplicate: boolean) => {
    const current = projectRef.current;
    if (current.frames.length >= 12) {
      onNotify('warning', 'Timeline complète', 'Le studio peut contenir jusqu’à 12 images.');
      return;
    }
    setIsPlaying(false);
    const source = current.frames[current.activeFrameIndex]?.pixels ?? createEmptyPixelMatrix(current.gridSize);
    const frame: PixelFrame = {
      id: newFrameId(),
      pixels: duplicate ? clonePixelMatrix(source) : createEmptyPixelMatrix(current.gridSize),
      durationMs: Math.round(1_000 / current.fps),
    };
    const nextFrames = current.frames.slice();
    nextFrames.splice(current.activeFrameIndex + 1, 0, frame);
    updateProject((value) => ({ ...value, frames: nextFrames, activeFrameIndex: current.activeFrameIndex + 1 }));
    resetHistory(frame.pixels);
  }, [onNotify, resetHistory, setIsPlaying, updateProject]);

  const deleteFrame = useCallback(() => {
    const current = projectRef.current;
    if (current.frames.length <= 1) {
      const blank = createEmptyPixelMatrix(current.gridSize);
      updateProject((value) => ({ ...value, frames: [{ ...value.frames[0], pixels: blank }], activeFrameIndex: 0 }));
      resetHistory(blank);
      return;
    }
    const nextFrames = current.frames.filter((_, index) => index !== current.activeFrameIndex);
    const nextIndex = Math.min(current.activeFrameIndex, nextFrames.length - 1);
    updateProject((value) => ({ ...value, frames: nextFrames, activeFrameIndex: nextIndex }));
    resetHistory(nextFrames[nextIndex].pixels);
    setIsPlaying(false);
  }, [resetHistory, updateProject]);

  const changeGridSize = useCallback((size: PixelGridSize) => {
    const current = projectRef.current;
    if (current.gridSize === size) return;
    const frames = current.frames.map((frame) => ({ ...frame, pixels: resizePixelMatrix(frame.pixels, size) }));
    updateProject((value) => ({ ...value, gridSize: size, frames }));
    resetHistory(frames[current.activeFrameIndex]?.pixels ?? createEmptyPixelMatrix(size));
    setFocusedCell((cell) => ({ x: Math.min(size - 1, cell.x), y: Math.min(size - 1, cell.y) }));
  }, [resetHistory, updateProject]);

  const choosePalette = useCallback((paletteId: PixelPaletteId) => {
    const colors = PIXEL_STUDIO_PALETTES[paletteId].colors;
    updateProject((current) => ({
      ...current,
      paletteId,
      paletteColors: [...colors],
      selectedColor: colors.includes(current.selectedColor) ? current.selectedColor : colors[0],
    }));
  }, [updateProject]);

  const addCustomColor = useCallback(() => {
    const color = customColor.toUpperCase();
    if (!isPixelColor(color) || color === '') return;
    const current = projectRef.current;
    if (current.paletteColors.includes(color)) {
      updateProject((value) => ({ ...value, selectedColor: color }));
      return;
    }
    if (current.paletteColors.length >= 32) {
      onNotify('warning', 'Palette complète', 'Retire une couleur avant d’en ajouter une autre.');
      return;
    }
    updateProject((value) => ({ ...value, paletteColors: [...value.paletteColors, color], selectedColor: color }));
  }, [customColor, onNotify, updateProject]);

  const changeFps = useCallback((fps: number) => {
    updateProject((current) => ({
      ...current,
      fps,
      frames: current.frames.map((frame) => ({ ...frame, durationMs: Math.round(1_000 / fps) })),
    }));
  }, [updateProject]);

  const handleGenerateSprite = useCallback(async () => {
    if (!aiPrompt.trim()) {
      onNotify('warning', 'Ajoute une description', 'Décris le sprite que tu veux créer avant de lancer la génération.');
      return;
    }
    setAiBusy('sprite');
    try {
      const response = await fetch('/api/pixel-studio/generate', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Génération indisponible.');
      const generated = resizePixelMatrix(matrixFromApi(payload.matrix, 16), projectRef.current.gridSize);
      updateProject((current) => ({
        ...current,
        frames: current.frames.map((frame, index) => index === current.activeFrameIndex ? { ...frame, pixels: generated } : frame),
        paletteColors: Array.from(new Set([...pixelColors(generated), ...current.paletteColors])).slice(0, 32),
      }));
      resetHistory(generated);
      const provider = payload.provider === 'nvidia' ? 'NVIDIA NIM' : 'Gemini';
      onNotify('success', 'Sprite généré', `${provider} a créé une image 16×16, agrandie dans la grille ${projectRef.current.gridSize}×${projectRef.current.gridSize}.`);
    } catch (error) {
      onNotify('error', 'Génération impossible', (error as Error).message || 'Réessaie dans un instant.');
    } finally {
      setAiBusy(null);
    }
  }, [aiPrompt, onNotify, resetHistory, updateProject]);

  const handleGenerateAnimation = useCallback(async () => {
    const current = projectRef.current;
    const hasPixels = current.frames[current.activeFrameIndex]?.pixels.some((row) => row.some(Boolean)) ?? false;
    if (!aiPrompt.trim() && !hasPixels) {
      onNotify('warning', 'Ajoute une base', 'Écris une description ou dessine une image à animer.');
      return;
    }
    setAiBusy('animation');
    try {
      const baseMatrix = resizePixelMatrix(current.frames[current.activeFrameIndex].pixels, 16);
      const response = await fetch('/api/pixel-studio/animate', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: aiPrompt,
          animationType,
          frameCount: aiFrameCount,
          currentMatrix: hasPixels ? baseMatrix : undefined,
        }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Génération indisponible.');
      if (!Array.isArray(payload.frames) || payload.frames.length !== aiFrameCount) throw new Error('Le modèle a retourné une animation incomplète.');
      const latest = projectRef.current;
      const nextFrames = payload.frames.map((value) => ({
        id: newFrameId(),
        pixels: resizePixelMatrix(matrixFromApi(value, 16), latest.gridSize),
        durationMs: Math.round(1_000 / latest.fps),
      }));
      updateProject((value) => ({
        ...value,
        frames: nextFrames,
        activeFrameIndex: 0,
        paletteColors: Array.from(new Set([...nextFrames.flatMap((frame) => pixelColors(frame.pixels)), ...value.paletteColors])).slice(0, 32),
      }));
      resetHistory(nextFrames[0].pixels);
      setIsPlaying(true);
      const provider = payload.provider === 'nvidia' ? 'NVIDIA NIM' : 'Gemini';
      onNotify('success', 'Animation générée', `${nextFrames.length} images préparées par ${provider}.`);
    } catch (error) {
      onNotify('error', 'Animation impossible', (error as Error).message || 'Réessaie dans un instant.');
    } finally {
      setAiBusy(null);
    }
  }, [aiFrameCount, aiPrompt, animationType, onNotify, resetHistory, updateProject]);

  const handleExport = useCallback(async (type: 'png' | 'spritesheet' | 'gif') => {
    setExportBusy(type);
    try {
      const filename = safeFileName(projectRef.current.name);
      if (type === 'png') {
        const blob = await exportPixelPng(projectRef.current.frames[projectRef.current.activeFrameIndex].pixels);
        downloadPixelFile(`${filename}.png`, blob);
        onNotify('success', 'PNG exporté', 'L’image a été téléchargée avec son fond transparent.');
      } else if (type === 'spritesheet') {
        const blob = await exportPixelSpritesheet(projectRef.current.frames);
        downloadPixelFile(`${filename}-spritesheet.png`, blob);
        onNotify('success', 'Spritesheet exportée', 'Les images de la timeline sont réunies dans un PNG horizontal.');
      } else {
        const blob = await exportPixelGif(projectRef.current.frames, projectRef.current.fps);
        downloadPixelFile(`${filename}.gif`, blob);
        onNotify('success', 'GIF exporté', 'L’animation en boucle a été téléchargée.');
      }
    } catch (error) {
      onNotify('error', 'Export impossible', (error as Error).message || 'Réessaie dans un instant.');
    } finally {
      setExportBusy(null);
    }
  }, [onNotify]);

  const handleImportProject = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 2_000_000) {
      onNotify('error', 'Fichier trop volumineux', 'La taille maximale d’un projet est de 2 Mo.');
      return;
    }
    try {
      const decoded = JSON.parse(await file.text()) as unknown;
      const restored = parsePixelStudioProject(decoded);
      if (!restored) throw new Error('Le fichier ne correspond pas à un projet Pixel Studio valide.');
      updateProject(() => restored);
      resetHistory(restored.frames[restored.activeFrameIndex].pixels);
      setIsPlaying(false);
      onNotify('success', 'Projet importé', 'Le projet est chargé et sera conservé dans ce navigateur.');
    } catch (error) {
      onNotify('error', 'Import impossible', (error as Error).message || 'Vérifie le fichier JSON.');
    }
  }, [onNotify, resetHistory, updateProject]);

  const handleClearFrame = useCallback(() => {
    const blank = createEmptyPixelMatrix(projectRef.current.gridSize);
    commitMatrix(blank);
    setIsPlaying(false);
  }, [commitMatrix]);

  const aiRouteLabel = aiStatus === 'loading' ? 'Vérification des modèles…'
    : aiProviders?.primaryAvailable && aiProviders.fallbackAvailable ? 'NVIDIA NIM → Gemini'
      : aiProviders?.primaryAvailable ? 'NVIDIA NIM · Gemini en secours si configuré'
        : aiProviders?.fallbackAvailable ? 'Gemini disponible · NIM non configuré'
          : 'IA non configurée · dessin manuel disponible';
  const aiHasPixels = matrix.some((row) => row.some(Boolean));

  return (
    <div className="ncraft-tab-panel__content pixel-studio">
      <div className="pixel-studio__heading">
        <div>
          <p className="nether-eyebrow">ATELIER CRÉATIF · LOCAL AU NAVIGATEUR</p>
          <h1>Pixel Studio</h1>
          <p>Un petit atelier de pixel art pour créer sprites et animations Minecraft, sans modifier ton serveur ni tes mondes.</p>
        </div>
        <div className={`pixel-studio__save-state ${storageAvailable ? '' : 'is-warning'}`} role="status" aria-live="polite">
          <Save size={15} aria-hidden="true" />
          <span>{storageAvailable ? 'Sauvegarde locale auto' : 'Stockage navigateur indisponible'}</span>
        </div>
      </div>

      <section className="pixel-studio__workspace" aria-label="Atelier Pixel Studio">
        <div className="pixel-studio__main-column">
          <NetherCard
            title="Plan de travail"
            eyebrow="SPRITE CANVAS"
            description="Clique ou glisse pour dessiner. Le fond en damier représente la transparence."
            icon={Grid2X2}
            accent="magma"
            className="pixel-studio__canvas-card"
            action={(
              <button type="button" className="pixel-studio__icon-action" onClick={handleClearFrame} aria-label="Effacer l’image active" title="Effacer l’image active">
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
          >
            <div className="pixel-studio__canvas-toolbar">
              <div className="pixel-studio__segmented" role="group" aria-label="Taille de la grille">
                {PIXEL_STUDIO_GRID_SIZES.map((size) => (
                  <button key={size} type="button" aria-pressed={project.gridSize === size} onClick={() => changeGridSize(size)}>
                    {size}×{size}
                  </button>
                ))}
              </div>
              <div className="pixel-studio__history-actions">
                <button type="button" className="pixel-studio__icon-action" aria-label="Annuler" title="Annuler (Ctrl+Z)" disabled={!historyAvailability.undo} onClick={undo}><Undo2 size={16} aria-hidden="true" /></button>
                <button type="button" className="pixel-studio__icon-action" aria-label="Rétablir" title="Rétablir (Ctrl+Maj+Z)" disabled={!historyAvailability.redo} onClick={redo}><Redo2 size={16} aria-hidden="true" /></button>
              </div>
            </div>

            <div className="pixel-studio__canvas-layout">
              <div className="pixel-studio__tool-rail" role="toolbar" aria-label="Outils de dessin">
                {TOOL_OPTIONS.map(({ id, label, shortcut, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={tool === id ? 'is-active' : ''}
                    aria-label={`${label} · raccourci ${shortcut}`}
                    aria-pressed={tool === id}
                    title={`${label} (${shortcut})`}
                    onClick={() => setTool(id)}
                  >
                    <Icon size={17} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <div className="pixel-studio__canvas-frame">
                <canvas
                  ref={canvasRef}
                  className="pixel-studio__canvas"
                  role="img"
                  tabIndex={0}
                  aria-label={`Pixel art ${project.gridSize} par ${project.gridSize}. Utilise les flèches pour déplacer le curseur et Espace pour appliquer l’outil.`}
                  aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Space Control+Z Control+Shift+Z"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onLostPointerCapture={(event) => finishStroke(event.pointerId)}
                  onKeyDown={handleCanvasKeyDown}
                  onContextMenu={(event) => event.preventDefault()}
                />
              </div>
            </div>

            <div className="pixel-studio__palette-block">
              <div className="pixel-studio__palette-heading">
                <div>
                  <span className="nether-eyebrow">PALETTE</span>
                  <strong>{PIXEL_STUDIO_PALETTES[project.paletteId].label}</strong>
                </div>
                <div className="pixel-studio__color-picker">
                  <span>Ajouter une couleur</span>
                  <input type="color" value={customColor} onChange={(event) => setCustomColor(event.target.value)} aria-label="Choisir une couleur personnalisée" />
                  <button type="button" className="pixel-studio__add-color" onClick={addCustomColor} aria-label="Ajouter la couleur choisie"><Plus size={15} aria-hidden="true" /></button>
                </div>
              </div>
              <div className="pixel-studio__palette-presets" role="group" aria-label="Palettes prédéfinies">
                {(Object.keys(PIXEL_STUDIO_PALETTES) as PixelPaletteId[]).map((paletteId) => (
                  <button key={paletteId} type="button" aria-pressed={project.paletteId === paletteId} onClick={() => choosePalette(paletteId)}>
                    {PIXEL_STUDIO_PALETTES[paletteId].label}
                  </button>
                ))}
              </div>
              <div className="pixel-studio__swatches" role="group" aria-label="Couleurs disponibles">
                {project.paletteColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={project.selectedColor === color ? 'is-selected' : ''}
                    style={{ '--swatch-color': color } as CSSProperties}
                    aria-label={`Couleur ${color}`}
                    aria-pressed={project.selectedColor === color}
                    title={color}
                    onClick={() => updateProject((current) => ({ ...current, selectedColor: color }))}
                  />
                ))}
                <button type="button" className="pixel-studio__transparent-swatch" aria-label="Choisir la transparence pour la gomme" onClick={() => setTool('eraser')}>∅</button>
              </div>
              <p className="pixel-studio__selected-color"><span style={{ backgroundColor: project.selectedColor }} aria-hidden="true" /> {project.selectedColor} sélectionnée</p>
            </div>
          </NetherCard>

          <NetherCard
            title="Timeline d’animation"
            eyebrow="FRAME SEQUENCER"
            description="Assemble jusqu’à 12 images, puis prévisualise et exporte l’animation."
            icon={Film}
            accent="portal"
            className="pixel-studio__timeline-card"
            action={(
              <button type="button" className="pixel-studio__icon-action" onClick={() => addFrame(false)} disabled={project.frames.length >= 12} aria-label="Ajouter une image vide" title="Ajouter une image vide">
                <Plus size={16} aria-hidden="true" />
              </button>
            )}
          >
            <div className="pixel-studio__timeline-controls">
              <div className="pixel-studio__timeline-playback">
                <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => setIsPlaying((playing) => !playing)} disabled={project.frames.length < 2}>
                  {isPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                  {isPlaying ? 'Pause' : 'Lire'}
                </button>
                <button type="button" className="pixel-studio__icon-action" onClick={() => addFrame(true)} disabled={project.frames.length >= 12} aria-label="Dupliquer l’image active" title="Dupliquer l’image active"><Plus size={16} aria-hidden="true" /><span className="pixel-studio__duplicate-mark">×</span></button>
                <button type="button" className="pixel-studio__icon-action" onClick={deleteFrame} aria-label="Supprimer l’image active" title="Supprimer l’image active"><Trash2 size={15} aria-hidden="true" /></button>
              </div>
              <label className="pixel-studio__fps-control">
                <span>Vitesse</span>
                <input type="range" min="1" max="20" value={project.fps} onChange={(event) => changeFps(Number(event.target.value))} aria-label={`Vitesse de lecture : ${project.fps} images par seconde`} />
                <strong>{project.fps} FPS</strong>
              </label>
            </div>
            <div className="pixel-studio__frames" role="tablist" aria-label="Images de l’animation">
              {project.frames.map((frame, index) => (
                <button
                  key={frame.id}
                  type="button"
                  role="tab"
                  aria-selected={project.activeFrameIndex === index}
                  aria-label={`Image ${index + 1}${project.activeFrameIndex === index ? ', active' : ''}`}
                  className={project.activeFrameIndex === index ? 'is-active' : ''}
                  onClick={() => chooseFrame(index)}
                >
                  <span className="pixel-studio__frame-preview" aria-hidden="true">
                    {frame.pixels.flat().some(Boolean) ? <span style={{ background: frame.pixels.flat().find(Boolean) }} /> : <i />}
                  </span>
                  <small>{String(index + 1).padStart(2, '0')}</small>
                </button>
              ))}
            </div>
            <p className="pixel-studio__timeline-footnote">Image {project.activeFrameIndex + 1} sur {project.frames.length} · chaque image reste modifiable avec les outils ci-dessus.</p>
          </NetherCard>
        </div>

        <aside className="pixel-studio__side-column" aria-label="Génération et export">
          <NetherCard
            title="Génération IA"
            eyebrow="NVIDIA NIM · GEMINI EN SECOURS"
            description="L’IA est appelée uniquement quand tu lances une génération. Les clés restent côté serveur."
            icon={Sparkles}
            accent="soul"
            className="pixel-studio__ai-card"
          >
            <div className={`pixel-studio__provider-status pixel-studio__provider-status--${aiStatus}`} role="status" aria-live="polite">
              <span aria-hidden="true" />
              <span>{aiRouteLabel}</span>
            </div>
            <label className="pixel-studio__field">
              <span>Description du sprite ou de l’animation</span>
              <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} maxLength={600} rows={4} placeholder="Ex. un petit cristal du Nether, violet et rouge, silhouette lisible…" />
              <small>{aiPrompt.length}/600 · envoyé au modèle seulement au clic, jamais conservé dans le projet local.</small>
            </label>
            <div className="pixel-studio__ai-buttons">
              <button type="button" className="nether-btn nether-btn--primary nether-btn--wide" onClick={() => void handleGenerateSprite()} disabled={aiBusy !== null || aiStatus === 'loading' || aiStatus === 'unavailable' || !aiPrompt.trim()}>
                {aiBusy === 'sprite' ? <Loader2 className="spin-soft" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
                {aiBusy === 'sprite' ? 'Création en cours…' : 'Générer un sprite'}
              </button>
              <div className="pixel-studio__animation-prompt-options">
                <label className="pixel-studio__field pixel-studio__field--compact">
                  <span>Style du mouvement</span>
                  <select value={animationType} onChange={(event) => setAnimationType(event.target.value)}>
                    {ANIMATION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </label>
                <label className="pixel-studio__field pixel-studio__field--compact">
                  <span>Images IA</span>
                  <select value={aiFrameCount} onChange={(event) => setAiFrameCount(Number(event.target.value))}>
                    {[2, 3, 4].map((count) => <option key={count} value={count}>{count} images</option>)}
                  </select>
                </label>
              </div>
              <button type="button" className="nether-btn nether-btn--quiet nether-btn--wide" onClick={() => void handleGenerateAnimation()} disabled={aiBusy !== null || aiStatus === 'loading' || aiStatus === 'unavailable' || (!aiPrompt.trim() && !aiHasPixels)}>
                {aiBusy === 'animation' ? <Loader2 className="spin-soft" size={16} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
                {aiBusy === 'animation' ? 'Animation en cours…' : 'Générer une animation'}
              </button>
            </div>
            <p className="pixel-studio__quiet-note">La génération d’animation remplace la timeline actuelle; exporte le projet JSON si tu veux garder cette version.</p>
            {aiStatus === 'unavailable' && <p className="pixel-studio__quiet-note">Aucune clé IA disponible côté serveur. Le dessin manuel et les exports restent accessibles.</p>}
            {aiProviders && !aiProviders.primaryAvailable && aiProviders.fallbackAvailable && <p className="pixel-studio__quiet-note">NVIDIA NIM n’est pas configuré; Gemini répondra seul jusqu’à ce que NIM soit disponible.</p>}
          </NetherCard>

          <NetherCard
            title="Export et projet"
            eyebrow="LOCAL FILES"
            description="Exporte le dessin, la timeline ou un fichier projet réimportable. Aucun fichier n’est installé sur Bedrock."
            icon={Download}
            accent="magma"
            className="pixel-studio__export-card"
          >
            <label className="pixel-studio__field pixel-studio__project-name">
              <span>Nom du projet</span>
              <input type="text" value={project.name} maxLength={64} onChange={(event) => updateProject((current) => ({ ...current, name: event.target.value.trim() ? event.target.value : 'Nouvelle création' }))} />
            </label>
            <div className="pixel-studio__export-grid">
              <button type="button" className="pixel-studio__export-button" onClick={() => void handleExport('png')} disabled={exportBusy !== null}>
                {exportBusy === 'png' ? <Loader2 size={16} className="spin-soft" aria-hidden="true" /> : <ImageIcon size={16} aria-hidden="true" />}
                <span><strong>Image PNG</strong><small>Image active · transparent</small></span>
              </button>
              <button type="button" className="pixel-studio__export-button" onClick={() => void handleExport('spritesheet')} disabled={exportBusy !== null}>
                {exportBusy === 'spritesheet' ? <Loader2 size={16} className="spin-soft" aria-hidden="true" /> : <Grid2X2 size={16} aria-hidden="true" />}
                <span><strong>Spritesheet</strong><small>{project.frames.length} image{project.frames.length > 1 ? 's' : ''} · PNG</small></span>
              </button>
              <button type="button" className="pixel-studio__export-button" onClick={() => void handleExport('gif')} disabled={exportBusy !== null || project.frames.length < 2}>
                {exportBusy === 'gif' ? <Loader2 size={16} className="spin-soft" aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
                <span><strong>Animation GIF</strong><small>{project.frames.length < 2 ? 'Ajoute une image' : `${project.fps} FPS · boucle`}</small></span>
              </button>
              <button type="button" className="pixel-studio__export-button" onClick={() => saveProjectJson(project)}>
                <FileJson size={16} aria-hidden="true" />
                <span><strong>Projet JSON</strong><small>Réimportable dans n-craft</small></span>
              </button>
            </div>
            <div className="pixel-studio__project-actions">
              <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => fileInputRef.current?.click()}><Upload size={14} aria-hidden="true" /> Importer un projet</button>
              <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void handleImportProject(event)} aria-label="Importer un fichier projet Pixel Studio" />
            </div>
          </NetherCard>

          <p className="pixel-studio__safety-note">Tes créations restent dans le navigateur ou dans les fichiers que tu télécharges. Pixel Studio ne touche ni aux mondes, ni aux packs installés, ni aux réglages du serveur.</p>
        </aside>
      </section>
    </div>
  );
}
