/** 上下文预算:token 粗估、历史挑选、截断标注(对应 test_hardening_p1.py 摘要部分)。 */
import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/chat/tokens";
import { selectHistory, fitText, IMAGE_TOKEN_COST, type HistoryMsg } from "../../src/chat/service";

describe("estimateTokens", () => {
  it("中文约 1 字 1 token,英文约 4 字符 1 token", () => {
    expect(estimateTokens("")).toBe(0);
    const cjk = estimateTokens("一二三四五");
    expect(cjk).toBeGreaterThan(4);
    expect(cjk).toBeLessThan(8);
    const eng = estimateTokens("abcdefgh"); // 8 字符 ≈ 2.2 + 1
    expect(eng).toBeGreaterThan(2);
    expect(eng).toBeLessThan(6);
  });
});

describe("selectHistory", () => {
  const model = { context_window: 400000, max_output_tokens: 32768 };
  const attMap = new Map();

  it("预算充足时全部保留", () => {
    const history: HistoryMsg[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, role: "user" as const, content: `消息${i}`, attachments: [],
    }));
    const sel = selectHistory(history, attMap, model, null);
    expect(sel.picked).toHaveLength(20);
    expect(sel.droppedCount).toBe(0);
  });

  it("预算极小时至少保留一条,其余计入 dropped", () => {
    const tiny = { context_window: 3000, max_output_tokens: 10 };
    const history: HistoryMsg[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, role: "user" as const, content: `消息${i}:${"长".repeat(2000)}`, attachments: [],
    }));
    const sel = selectHistory(history, attMap, tiny, null);
    // 每条约 2100 token,预算下限 2000:只有最新一条(强制保留)装得下
    expect(sel.picked).toHaveLength(1);
    expect(sel.droppedCount).toBe(4);
    expect(sel.picked[0]!.id).toBe("m4"); // 保留最新
  });

  it("图片附件按固定成本计入", () => {
    const tiny = { context_window: 1500, max_output_tokens: 10 };
    const map = new Map([["a1", { id: "a1", kind: "image" as const, filename: "x.png", extracted_text: null }]]);
    const history: HistoryMsg[] = [
      { id: "m0", role: "user", content: "带图", attachments: [{ id: "a1", kind: "image" }] },
    ];
    const sel = selectHistory(history, map, tiny, null);
    // 1200(图) + 文本 + 系统提示 ~200 预算 1500-10-6000<2000 → 2000
    expect(IMAGE_TOKEN_COST).toBe(1200);
    expect(sel.picked).toHaveLength(1);
  });
});

describe("fitText", () => {
  it("超长文本被截断并明确标注", () => {
    const text = "长".repeat(10000);
    const out = fitText(text, 500);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("【内容过长,已截断");
  });

  it("不超长原样返回", () => {
    expect(fitText("短文本", 100)).toBe("短文本");
  });
});
