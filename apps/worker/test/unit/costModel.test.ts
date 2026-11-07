/** P2.4:成本模型正确性测试(用户点名:12 人/天、2/5/10/20MB 档位、区分累计与日增)。 */
import { describe, it, expect } from "vitest";
import { computeCost, queueCallsPerImage } from "../../src/domain/costModel";

describe("queueCallsPerImage(实测锚点校准)", () => {
  it.each([
    [2, 5], [5, 9], [10, 15], [20, 29],
  ])("%iMB → %i 次队列调用(±1 实测容差)", (mb, expected) => {
    const calls = queueCallsPerImage(mb);
    expect(Math.abs(calls - expected)).toBeLessThanOrEqual(2);
  });
  it("单调递增:档位越大调用越多", () => {
    expect(queueCallsPerImage(2)).toBeLessThan(queueCallsPerImage(10));
    expect(queueCallsPerImage(10)).toBeLessThan(queueCallsPerImage(20));
  });
});

describe("computeCost(12 人年级)", () => {
  const base = { teachers: 12, chatRoundsPerTeacher: 20, imageMB: 5 as const, teachingDays: 22, upstreamPricePerImageUSD: 0.02 };

  it("P2.4 指正:AI 费用 = 12 人合计,不是单人 × 1", () => {
    const r5 = computeCost({ ...base, imagesPerTeacher: 5 });
    expect(r5.upstreamUSDPerDay).toBeCloseTo(12 * 5 * 0.02, 4); // $1.20/天
    expect(r5.upstreamUSDPerPeriod).toBeCloseTo(1.2 * 22, 2); // $26.40/月
  });

  it("R2 容量:12 人共同产生,区分日增与周期累计 GB-month", () => {
    const r = computeCost({ ...base, imagesPerTeacher: 20, imageMB: 5 });
    // 12×20×5MB = 1200MB/天 ≈ 1.17GB/天
    expect(r.r2NewBytesPerDay).toBeCloseTo(12 * 20 * 5 * 1024 * 1024, 0);
    expect(r.r2GBMonthAtPeriod).toBeGreaterThan(25); // 22 天累计 ≈ 25.7GB → 必须触发预警
    expect(r.notes.join("\n")).toContain("预警");
  });

  it("Queues:20MB 档位 12×20 张/天 接近免费上限(29 ops/张)", () => {
    const r = computeCost({ ...base, imagesPerTeacher: 20, imageMB: 20 });
    // 12×20×29 = 6,960 ops/天,占免费 10,000 的 70% —— 高压档位,已如实呈现
    expect(r.queueOpsPerDay).toBe(12 * 20 * 29);
    expect(r.queuePctOfFree).toBeGreaterThan(60);
    expect(r.notes.join("\n")).toContain("队列调用");
    // 2MB 档位则宽松
    const r2 = computeCost({ ...base, imagesPerTeacher: 20, imageMB: 2 });
    expect(r2.queueOpsPerDay).toBeLessThan(r.queueOpsPerDay / 2);
  });

  it("Cloudflare 侧恒为 $0(免费套餐承诺)", () => {
    const r = computeCost({ ...base, imagesPerTeacher: 20, imageMB: 20 });
    expect(r.cloudflareUSDMonth).toBe(0);
  });

  it("每日请求数在免费 10 万内(12 人规模)", () => {
    const r = computeCost({ ...base, imagesPerTeacher: 20 });
    expect(r.workerDynamicRequestsPerDay).toBeLessThan(10_000);
  });
});
