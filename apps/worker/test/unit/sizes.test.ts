/** 15 画幅原生尺寸回归 —— 对应原 test_regression_v2.py 的 2K 断言。 */
import { describe, it, expect } from "vitest";
import { getSizePreset, nativeSizeFor, sizePresetsPublic, SIZE_PRESETS, validateNativeSize } from "../../src/domain/images";

describe("15 画幅原生 2K 计算", () => {
  it("预设清单与原项目一致(15 项,分组与默认值)", () => {
    expect(SIZE_PRESETS).toHaveLength(15);
    expect(SIZE_PRESETS.map((p) => p.id)).toEqual([
      "1:1", "a5", "a5-h", "a4", "a4-h", "a3", "a3-h", "a2", "a2-h", "a1", "a1-h",
      "4:3", "3:4", "16:9", "9:16",
    ]);
    expect(getSizePreset(null).id).toBe("a4");
  });

  it.each([
    ["1:1", 2048, 2048],
    ["a4", 1456, 2048],
    ["a4-h", 2048, 1456],
    ["a5", 1456, 2048],
    ["a5-h", 2048, 1456],
    ["a3", 1456, 2048],
    ["a3-h", 2048, 1456],
    ["a2", 1456, 2048],
    ["a2-h", 2048, 1456],
    ["a1", 1456, 2048],
    ["a1-h", 2048, 1456],
    ["4:3", 2048, 1536],
    ["3:4", 1536, 2048],
    ["16:9", 2048, 1152],
    ["9:16", 1152, 2048],
  ])("%s → %ix%i", (id, w, h) => {
    const size = nativeSizeFor(getSizePreset(id));
    expect(size.w).toBe(w);
    expect(size.h).toBe(h);
  });

  it("旧像素尺寸映射保留", () => {
    expect(getSizePreset("1024x1024").id).toBe("1:1");
    expect(getSizePreset("1536x1024").id).toBe("4:3");
    expect(getSizePreset("1024x1536").id).toBe("a4");
    expect(getSizePreset("unknown").id).toBe("a4");
  });

  it("上游约束:16 倍数 / 长边 ≤3840 / 比例 ≤3:1 / 总像素范围", () => {
    expect(validateNativeSize(2048, 2048)).toEqual({ w: 2048, h: 2048 });
    expect(() => validateNativeSize(2047, 2048)).toThrow(/16 的倍数/);
    expect(() => validateNativeSize(3856, 2048)).toThrow(/长边/);
    expect(() => validateNativeSize(3456, 1024)).toThrow(/长宽比/); // 3.375:1
    expect(() => validateNativeSize(1024, 608)).toThrow(/总像素/); // 622,720 < 655,360 下限
    expect(validateNativeSize(1024, 640)).toEqual({ w: 1024, h: 640 }); // 655,360 恰为下限,放行
  });

  it("public presets 输出含 pixels/native_width/native_height(前端契约)", () => {
    const presets = sizePresetsPublic();
    expect(presets).toHaveLength(15);
    const a4 = presets.find((p) => p.id === "a4")!;
    expect(a4.pixels).toBe("1456×2048");
    expect(a4.native_width).toBe(1456);
    expect(a4.native_height).toBe(2048);
    expect(a4.group).toBe("A 系列纸张");
  });
});
