/**
 * 尺寸预设与原生 2K 计算 —— image_provider.py 的逐行翻译(纯函数,可参数化测试)。
 *
 * 上游约束(GPT Image 2.6):长边 ≤ 3840、宽高均为 16 的倍数、比例 ≤ 3:1、
 * 总像素 [655360, 8294400]。正常路径不做任何缩放/裁切;尺寸异常由任务层如实标注。
 */
export const SIZE_MULTIPLE = 16;
export const MAX_NATIVE_LONG_EDGE = 3840;
export const MAX_ASPECT_RATIO = 3.0;
export const MIN_TOTAL_PIXELS = 655_360;
export const MAX_TOTAL_PIXELS = 8_294_400;
export const MAX_AUTO_CROP_DEVIATION = 0.06;
export const MAX_DECODE_PIXELS = 40_000_000;
export const OUTPUT_LONG_EDGE = 2048;

const A_PORTRAIT = 1 / 1.41421356;
const A_LANDSCAPE = 1.41421356;
const G_PAPER = "A 系列纸张";
const G_RATIO = "常用比例";

export interface SizePresetDef {
  id: string;
  label: string;
  ratio: number;
  group: string;
  orientation: "square" | "portrait" | "landscape";
}

export const SIZE_PRESETS: SizePresetDef[] = [
  { id: "1:1", label: "1:1 方形", ratio: 1.0, group: "方形", orientation: "square" },
  { id: "a5", label: "A5 竖版", ratio: A_PORTRAIT, group: G_PAPER, orientation: "portrait" },
  { id: "a5-h", label: "A5 横版", ratio: A_LANDSCAPE, group: G_PAPER, orientation: "landscape" },
  { id: "a4", label: "A4 竖版", ratio: A_PORTRAIT, group: G_PAPER, orientation: "portrait" },
  { id: "a4-h", label: "A4 横版", ratio: A_LANDSCAPE, group: G_PAPER, orientation: "landscape" },
  { id: "a3", label: "A3 竖版", ratio: A_PORTRAIT, group: G_PAPER, orientation: "portrait" },
  { id: "a3-h", label: "A3 横版", ratio: A_LANDSCAPE, group: G_PAPER, orientation: "landscape" },
  { id: "a2", label: "A2 竖版", ratio: A_PORTRAIT, group: G_PAPER, orientation: "portrait" },
  { id: "a2-h", label: "A2 横版", ratio: A_LANDSCAPE, group: G_PAPER, orientation: "landscape" },
  { id: "a1", label: "A1 竖版", ratio: A_PORTRAIT, group: G_PAPER, orientation: "portrait" },
  { id: "a1-h", label: "A1 横版", ratio: A_LANDSCAPE, group: G_PAPER, orientation: "landscape" },
  { id: "4:3", label: "4:3 横版", ratio: 4 / 3, group: G_RATIO, orientation: "landscape" },
  { id: "3:4", label: "3:4 竖版", ratio: 3 / 4, group: G_RATIO, orientation: "portrait" },
  { id: "16:9", label: "16:9 横版", ratio: 16 / 9, group: G_RATIO, orientation: "landscape" },
  { id: "9:16", label: "9:16 竖版", ratio: 9 / 16, group: G_RATIO, orientation: "portrait" },
];

export const DEFAULT_SIZE_PRESET = "a4";
export const LEGACY_SIZES: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1024": "4:3",
  "1024x1536": "a4",
};

export class SizeError extends Error {}

export function getSizePreset(value: string | null | undefined): SizePresetDef {
  const key = (value || "").trim();
  const mapped = LEGACY_SIZES[key] ?? key;
  return SIZE_PRESETS.find((p) => p.id === mapped)
    ?? SIZE_PRESETS.find((p) => p.id === DEFAULT_SIZE_PRESET)!;
}

function round16(value: number): number {
  return Math.max(SIZE_MULTIPLE, Math.round(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);
}

export function validateNativeSize(w: number, h: number): { w: number; h: number } {
  if (w % SIZE_MULTIPLE !== 0 || h % SIZE_MULTIPLE !== 0) {
    throw new SizeError("输出尺寸必须是 16 的倍数");
  }
  if (Math.max(w, h) > MAX_NATIVE_LONG_EDGE) throw new SizeError("输出尺寸超过上游长边限制");
  if (Math.max(w / h, h / w) > MAX_ASPECT_RATIO) throw new SizeError("输出尺寸超过上游长宽比限制");
  const total = w * h;
  if (total < MIN_TOTAL_PIXELS || total > MAX_TOTAL_PIXELS) {
    throw new SizeError("输出尺寸超过上游总像素限制");
  }
  return { w, h };
}

export function nativeSizeFor(preset: SizePresetDef, longEdge?: number): { w: number; h: number } {
  const edge = round16(
    Math.min(MAX_NATIVE_LONG_EDGE, Math.max(1024, Math.trunc(longEdge || OUTPUT_LONG_EDGE))),
  );
  const ratio = preset.ratio;
  const { w, h } = ratio >= 1
    ? { w: edge, h: round16(edge / ratio) }
    : { w: round16(edge * ratio), h: edge };
  return validateNativeSize(w, h);
}

export interface PublicPreset {
  id: string;
  label: string;
  pixels: string;
  ratio: number;
  group: string;
  orientation: string;
  native_width: number;
  native_height: number;
}

export function sizePresetsPublic(): PublicPreset[] {
  return SIZE_PRESETS.map((p) => {
    const { w, h } = nativeSizeFor(p);
    return {
      id: p.id,
      label: p.label,
      pixels: `${w}×${h}`,
      ratio: Math.round(p.ratio * 10000) / 10000,
      group: p.group,
      orientation: p.orientation,
      native_width: w,
      native_height: h,
    };
  });
}

/** 生图模型白名单(与原 DEFAULT_MODELS 一致;描述文案原样保留)。 */
export const IMAGE_MODELS = [
  {
    id: "gpt-image-2.6-flare",
    label: "GPT Image 2.6 Flare",
    tag: "FLARE",
    description: "漫画、教学插画、局部修改",
    supports_edit: true,
    supports_reference: true,
    enabled: true,
    health: "ok",
    sizes: SIZE_PRESETS.map((p) => p.id),
    qualities: ["2K"],
  },
  {
    id: "gpt-image-2.6-sunburst",
    label: "GPT Image 2.6 Sunburst",
    tag: "SUNBURST",
    description: "海报、复杂场景、创意作品",
    supports_edit: true,
    supports_reference: true,
    enabled: true,
    health: "ok",
    sizes: SIZE_PRESETS.map((p) => p.id),
    qualities: ["2K"],
  },
];

export function getImageModel(modelId: string): (typeof IMAGE_MODELS)[number] | undefined {
  return IMAGE_MODELS.find((m) => m.id === modelId && m.enabled);
}
