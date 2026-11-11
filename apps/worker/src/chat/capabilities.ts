/**
 * 对话模型能力注册表 —— capabilities.py 的完整翻译,全站唯一白名单。
 * 9 款模型(全部上游可用)、4 档思考、各家用原生协议映射。
 */
export const THINKING_LEVELS = ["fast", "standard", "deep", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  fast: "快速", standard: "标准", deep: "深度", ultra: "极深度",
};

interface ThinkingSpec {
  kind: "openai_effort" | "anthropic_budget" | "gemini";
  mode?: string;
  map?: Record<ThinkingLevel, string>;
  budgets?: Record<ThinkingLevel, number>;
  levels?: Record<ThinkingLevel, string>;
  adaptive?: boolean;
}

export interface ChatModelSpec {
  id: string;
  label: string;
  vendor: string;
  api_model: string;
  transport: "openai_responses" | "anthropic_messages" | "google_gemini";
  description: string;
  default?: boolean;
  status: "ok" | "unavailable";
  status_reason?: string;
  supports_vision: boolean;
  supports_documents: boolean;
  supports_tools: boolean;
  context_window: number;
  max_output_tokens: number;
  thinking: ThinkingSpec;
}

export const MODELS: ChatModelSpec[] = [
  {
    id: "gpt-6.1-sol", label: "GPT-6.1 Sol", vendor: "OpenAI", api_model: "gpt-6.1-sol",
    transport: "openai_responses",
    description: "默认模型。推理与写作均衡,适合备课问答、任务单设计与长文整理。",
    default: true, status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 400000, max_output_tokens: 32768,
    thinking: { kind: "openai_effort", map: { fast: "minimal", standard: "medium", deep: "high", ultra: "xhigh" } },
  },
  {
    id: "gpt-6.1-terra", label: "GPT-6.1 Terra", vendor: "OpenAI", api_model: "gpt-6.1-terra",
    transport: "openai_responses",
    description: "响应更快、成本更低,适合日常短问答与批量润色。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 400000, max_output_tokens: 32768,
    thinking: { kind: "openai_effort", map: { fast: "minimal", standard: "medium", deep: "high", ultra: "xhigh" } },
  },
  {
    id: "gpt-6-astra", label: "GPT-6 Astra", vendor: "OpenAI", api_model: "gpt-6-astra",
    transport: "openai_responses",
    description: "长上下文与多模态理解较强,适合一次读入整份单元材料。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 1000000, max_output_tokens: 32768,
    thinking: { kind: "openai_effort", map: { fast: "minimal", standard: "medium", deep: "high", ultra: "xhigh" } },
  },
  {
    id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", vendor: "Anthropic", api_model: "claude-sonnet-5-5",
    transport: "anthropic_messages",
    description: "英文表达与教学语感自然,适合改写语篇、生成课堂用语与评语。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 200000, max_output_tokens: 32000,
    thinking: { kind: "anthropic_budget", budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 32000 } },
  },
  {
    id: "claude-opus-5-5", label: "Claude Opus 5.5", vendor: "Anthropic", api_model: "claude-opus-5-5",
    transport: "anthropic_messages",
    description: "更强的推理与长文组织能力,适合课程设计、评分标准与复杂任务拆解。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 200000, max_output_tokens: 32000,
    thinking: { kind: "anthropic_budget", budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 32000 }, adaptive: true },
  },
  {
    id: "claude-fable-5-2", label: "Claude Fable 5.2", vendor: "Anthropic", api_model: "claude-fable-5-2",
    transport: "anthropic_messages",
    description: "叙事与创意表达见长,适合故事化语篇、绘本脚本与情境对话改写。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 200000, max_output_tokens: 32000,
    thinking: { kind: "anthropic_budget", budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 32000 } },
  },
  {
    id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", vendor: "Google", api_model: "gemini-3.8-flash",
    transport: "google_gemini",
    description: "速度最快,适合课堂即时提问、单词讲解与快速翻译。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 1000000, max_output_tokens: 32768,
    thinking: {
      kind: "gemini", mode: "budget",
      levels: { fast: "low", standard: "low", deep: "high", ultra: "high" },
      budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 24576 },
    },
  },
  {
    id: "gemini-4-argon", label: "Gemini 4 Argon", vendor: "Google", api_model: "gemini-4-argon",
    transport: "google_gemini",
    description: "多模态强、上下文长,适合带图分析与整册材料检索式问答。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 1000000, max_output_tokens: 32768,
    thinking: {
      kind: "gemini", mode: "budget",
      levels: { fast: "low", standard: "low", deep: "high", ultra: "high" },
      budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 24576 },
    },
  },
  {
    id: "gemini-4-carbon", label: "Gemini 4 Carbon", vendor: "Google", api_model: "gemini-4-carbon",
    transport: "google_gemini",
    description: "新一代多模态长上下文,适合整册材料问答与带图分析。",
    status: "ok", supports_vision: true, supports_documents: true, supports_tools: true,
    context_window: 1000000, max_output_tokens: 32768,
    thinking: {
      kind: "gemini", mode: "budget",
      levels: { fast: "low", standard: "low", deep: "high", ultra: "high" },
      budgets: { fast: 0, standard: 2048, deep: 8192, ultra: 24576 },
    },
  },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
export const DEFAULT_MODEL = MODELS.find((m) => m.default)!.id;
export const UNAVAILABLE_MODELS = new Set(MODELS.filter((m) => m.status !== "ok").map((m) => m.id));

export function getChatModel(modelId: string | null | undefined): ChatModelSpec | undefined {
  return modelId ? BY_ID.get(modelId) : undefined;
}

function levelSupported(model: ChatModelSpec, level: ThinkingLevel): boolean {
  const t = model.thinking;
  if (t.kind === "anthropic_budget") {
    const b = t.budgets?.[level];
    return b !== undefined && (b > 0 || level === "fast");
  }
  if (t.kind === "openai_effort") return level in (t.map || {});
  return level in (t.budgets || {});
}

export function resolveThinking(model: ChatModelSpec, level: ThinkingLevel): Record<string, unknown> {
  if (!levelSupported(model, level)) {
    throw new Error(`${model.label} 不支持「${THINKING_LABELS[level] ?? level}」档`);
  }
  const t = model.thinking;
  if (t.kind === "openai_effort") return { reasoning: { effort: t.map![level] } };
  if (t.kind === "anthropic_budget") {
    const budget = t.budgets![level];
    if (budget <= 0) return { thinking: null };
    if (level === "ultra" && t.adaptive) {
      return { thinking: { type: "adaptive" }, anthropic_beta: "context-management-2025-06-27" };
    }
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }
  // gemini
  if (t.budgets![level] === 0) return { thinkingConfig: { thinkingBudget: 0 } };
  return { thinkingConfig: { thinkingBudget: t.budgets![level] } };
}

export function publicModels(): Record<string, unknown> {
  const items = MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    vendor: m.vendor,
    description: m.description,
    status: m.status,
    status_reason: m.status_reason || "",
    supports_vision: m.supports_vision,
    supports_documents: m.supports_documents,
    context_window: m.context_window,
    max_output_tokens: m.max_output_tokens,
    available_thinking: THINKING_LEVELS.filter((lv) => m.status === "ok" && levelSupported(m, lv)),
    default_thinking: "standard",
  }));
  return {
    items,
    default: DEFAULT_MODEL,
    thinking_levels: THINKING_LEVELS.map((lv) => ({ id: lv, label: THINKING_LABELS[lv] })),
    default_thinking: "standard",
  };
}
