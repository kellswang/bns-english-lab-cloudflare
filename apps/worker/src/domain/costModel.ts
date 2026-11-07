/**
 * P2.4:免费套餐成本模型 —— 纯函数,可测试。
 * 所有操作次数来自代码路径实测(spike / 集成测试),标注依据;
 * Cloudflare 计量以官方 Dashboard 为准,本模型用于预算与预警。
 */

export interface CostInput {
  teachers: number;
  chatRoundsPerTeacher: number; // 每教师每天对话轮数
  imagesPerTeacher: number; // 每教师每天生成张数
  imageMB: 2 | 5 | 10 | 20; // 档位
  teachingDays: number; // 统计周期(教学日)
  upstreamPricePerImageUSD: number;
}

export interface CostResult {
  workerDynamicRequestsPerDay: number;
  d1RowsReadPerDay: number;
  d1RowsWrittenPerDay: number;
  queueOpsPerDay: number;
  queuePctOfFree: number; // 相对 10,000/天
  r2NewBytesPerDay: number;
  r2GBMonthAtPeriod: number; // 周期末累计 GB-month 近似
  upstreamUSDPerDay: number;
  upstreamUSDPerPeriod: number;
  cloudflareUSDMonth: 0;
  notes: string[];
}

/**
 * 每张图队列调用次数 —— 使用 spikes/gateA-bigpayload 实测锚点线性插值:
 *   2MB→5,5MB→9,10MB→15,20MB→29(≈1.2 次/MB)。
 * 结构 = 1 start + rawWindows(2MB 捕获分块)+ b64Chunks(按窗口边界 flush)。
 * 线上真实 CPU/调用次数以 live-cpu-probe 实测为准;此处仅用于预算。
 */
const MEASURED_QUEUE_CALLS: Array<[number, number]> = [[2, 5], [5, 9], [10, 15], [20, 29]];

export function queueCallsPerImage(imageMB: number): number {
  const sorted = MEASURED_QUEUE_CALLS;
  if (imageMB <= sorted[0]![0]) {
    const [x0, y0] = sorted[0]!;
    return Math.max(2, Math.round(y0 * (imageMB / x0)));
  }
  const last = sorted[sorted.length - 1]!;
  if (imageMB >= last[0]) {
    const slope = (last[1] - sorted[sorted.length - 2]![1]) / (last[0] - sorted[sorted.length - 2]![0]);
    return Math.round(last[1] + slope * (imageMB - last[0]));
  }
  for (let i = 1; i < sorted.length; i++) {
    const [x0, y0] = sorted[i - 1]!;
    const [x1, y1] = sorted[i]!;
    if (imageMB <= x1) {
      return Math.round(y0 + ((y1 - y0) * (imageMB - x0)) / (x1 - x0));
    }
  }
  return last[1];
}

export function computeCost(input: CostInput): CostResult {
  const { teachers, chatRoundsPerTeacher, imagesPerTeacher, imageMB, teachingDays, upstreamPricePerImageUSD } = input;
  const notes: string[] = [];

  // Worker 动态请求:对话(2/轮)+ 生图(1 生成 + 轮询 6~10,自适应退避均值 8)+ 页面初始化 6/人
  const chatReqs = teachers * chatRoundsPerTeacher * 2;
  const imageReqs = teachers * imagesPerTeacher * (1 + 8);
  const pageReqs = teachers * 6;
  const workerDynamicRequestsPerDay = chatReqs + imageReqs + pageReqs;

  // D1:读(消息/版本/列表/日志)、写(消息/检查点/任务状态/审计)
  const d1RowsReadPerDay = chatReqs * 40 + imagesPerTeacher * teachers * 60 + teachers * 2000;
  const d1RowsWrittenPerDay = chatReqs * 6 + imagesPerTeacher * teachers * 25;

  // Queues:每张 5~29 ops(实测),每 ops 含写+读+删
  const callsPerImage = queueCallsPerImage(imageMB);
  const queueOpsPerDay = teachers * imagesPerTeacher * callsPerImage;
  notes.push(`队列调用/张 = ${callsPerImage}(实测锚点插值:2MB→5 / 5MB→9 / 10MB→15 / 20MB→29;线上以 live-cpu-probe 为准)`);
  if (queueOpsPerDay > 10_000) {
    notes.push(`⚠ Queues ${queueOpsPerDay}/天超过免费 10,000/天 —— 建议引导小档位或降低生图量,不得静默升级付费`);
  }

  // R2:新数据/天 与 周期末累计(简化:线性累计,免费层为月均 GB-month)
  const r2NewBytesPerDay = teachers * imagesPerTeacher * imageMB * 1024 * 1024;
  const r2GBMonthAtPeriod = Math.round(((r2NewBytesPerDay * teachingDays) / (1024 ** 3)) * 100) / 100;
  if (r2GBMonthAtPeriod > 7) {
    notes.push(`⚠ 累计 ${r2GBMonthAtPeriod}GB 接近免费 10GB —— 管理页 7GB 预警线触发,按手册归档`);
  }

  const upstreamUSDPerDay = Math.round(teachers * imagesPerTeacher * upstreamPricePerImageUSD * 10000) / 10000;
  const upstreamUSDPerPeriod = Math.round(upstreamUSDPerDay * teachingDays * 10000) / 10000;
  notes.push("对话费用按上游 token 账单单独核对(Cron 每 15 分钟),不计入本图片估算");
  notes.push("Cloudflare 侧免费套餐内 = $0;任何资源触达额度都以 429/报警呈现,不自动升级");

  return {
    workerDynamicRequestsPerDay,
    d1RowsReadPerDay,
    d1RowsWrittenPerDay,
    queueOpsPerDay,
    queuePctOfFree: Math.round((queueOpsPerDay / 10_000) * 100),
    r2NewBytesPerDay,
    r2GBMonthAtPeriod,
    upstreamUSDPerDay,
    upstreamUSDPerPeriod,
    cloudflareUSDMonth: 0,
    notes,
  };
}
