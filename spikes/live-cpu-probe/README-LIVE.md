# live-cpu-probe — Cloudflare Free 三通道 CPU 实测手册

> 目的:在**真实免费套餐**上取得 HTTP Worker / Queues Consumer / Cron 三种调用的
> 真实 CPU 毫秒数,替代本地 workerd 无法证明的部分(FEASIBILITY 闸门 A/B 的线上部分)。
> 全程免费资源,验证完 `wrangler delete` 即可,不产生任何费用。

## 0. 前置(需要授权的最低权限)

- 一个 **Cloudflare Free 账户**的 API Token(权限:`Workers Scripts:Edit`、
  `D1:Edit`、`Workers R2 Storage:Edit`、`Queues:Edit`——即可在**探针资源**上部署,
  不触碰任何生产资源);
- 或者由年级负责人在本机 `npx wrangler login` 一次。

## 1. 部署(5 条命令)

```bash
cd spikes/live-cpu-probe
npx wrangler d1 create bns-elab-probe-db          # 把 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create bns-elab-probe-media
npx wrangler queues create bns-elab-probe-q
npx wrangler deploy
```

## 2. 采集 CPU 毫秒(关键:用 `wrangler tail` 的 cpuTime 字段)

```bash
npx wrangler tail --format json > tail.log        # 窗口 A:保持运行
```

窗口 B 依次触发(每条 2-3 次):

```bash
BASE=https://bns-elab-cpu-probe.<账户子域>.workers.dev
curl "$BASE/setup?mb=20"
curl "$BASE/probe/b64-inline?mb=10"    # 传统整图路径(预期超 10ms → 免费套餐失败证据)
curl "$BASE/probe/b64-inline?mb=20"
curl "$BASE/probe/slice?mb=20"         # 流水线单片(生产 decode 单次成本,预期 ≤10ms)
curl "$BASE/probe/scan?mb=20"          # 流水线扫描窗口
curl "$BASE/probe/assemble?mb=20"      # 纯 I/O 合成(预期 ≈0 CPU)
curl "$BASE/probe/queue?mb=20"         # Queues 通道(consumer CPU)
# Cron:等待下一个 */15 触发,或在 Dashboard → Cron Triggers 手动触发
curl "$BASE/probe/results"             # 队列执行结果
```

## 3. 汇总

```bash
powershell -Command "Get-Content tail.log | ConvertFrom-Json | ... 提取 event.response 与 cpuTime"
```

或直接在 Dashboard → Workers & Pages → bns-elab-cpu-probe → Metrics →
**CPU Time per invocation(p50/p99)** 读图。

填写验收表:

| 探针 | 档位 | cpuTime p50 | cpuTime p99 | ≤10ms? |
|---|---|---|---|---|
| b64-inline 整图 | 10MB / 20MB | | | (预期否) |
| slice 单片解码 | 20MB | | | 目标:是 |
| scan 窗口 | 20MB | | | 目标:是 |
| assemble 合成 | 20MB | | | 目标:是 |
| queue consumer | 20MB | | | 目标:是 |
| cron scheduled | 10MB | | | 目标:是 |

## 4. 判定与清理

- 全部"目标:是"通过 → 免费套餐可行,把结论与数字写入 `docs/FEASIBILITY.md`;
- b64-inline 超限 → 证明必须走流水线(现实现已是流水线,不受影响);
- slice/scan 超限 → 把 `imgpipe.ts` 的 B64_CHUNK_CHARS / RAW_CAPTURE_CHUNK 调小后重测;
- 验证完成:

```bash
npx wrangler delete            # 删除探针 Worker
npx wrangler d1 delete bns-elab-probe-db
npx wrangler r2 bucket delete bns-elab-probe-media
npx wrangler queues delete bns-elab-probe-q
```
