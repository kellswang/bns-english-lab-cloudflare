# TEST_REPORT — 测试报告

执行日期:2026-11-06/07 · 环境:Windows + Node 24 · 本地运行时:wrangler getPlatformProxy(workerd,与生产同运行时)

## 1. 已运行命令与结果

| 命令 | 结果 |
|---|---|
| `tsc --noEmit`(worker,strict) | ✅ 0 错误 |
| `vitest run`(apps/worker) | ✅ **9 文件 / 67 测试全通过**,0 失败 0 跳过 |
| `vue-tsc --noEmit`(web) | ✅ 0 错误 |
| `vite build`(web) | ✅ 65 模块,dist 产物含登录视频媒体 |
| `npx tsx spikes/gateA-bigpayload.mts` | ✅ 2/5/10/20MB b64→R2→D1 全链路,字节精确 |

## 2. 测试矩阵

| 测试项 | 类型 | 结果 | 证据位置 | 限制或风险 |
|---|---|---|---|---|
| 15 画幅原生 2K 计算回归(含旧尺寸映射、上游约束边界) | 单元 | ✅ 通过 | test/unit/sizes.test.ts | — |
| SSE 行解析:跨 chunk UTF-8、半截行、[DONE] | 单元 | ✅ | test/unit/sse.test.ts | — |
| JWT 签发/校验/篡改/过期/alg 混淆;OTP HMAC | 单元 | ✅ | test/unit/tokens.test.ts | — |
| 三家协议事件流 fixture(delta/meta/usage/error、request_id 口径、thinking_delta 过滤、Gemini 流末 meta) | 单元(mock fetch) | ✅ | test/unit/providers.test.ts | 真实上游未测 |
| 上下文预算/历史挑选/截断标注 | 单元 | ✅ | test/unit/chatBudget.test.ts | — |
| health、auth/config、域名强校验、白名单外 403 不留记录、错码 5 次 429、单次核销、冷却 429、停用即 403、管理员权限 | 集成(workerd D1) | ✅ | test/integration/auth.test.ts | Resend 真实发信未测 |
| 生成幂等:同键去重 replay、同键异参 409、每日限额 429 + 计数退回 | 集成 | ✅ | test/integration/generation.test.ts | — |
| 队列状态机:成功产出版本、b64 入 R2、meta 更新、**重复投递不产生第二个版本**、上游 5xx → **uncertain 且只调一次上游** | 集成 | ✅ | 同上 | 上游为 mock |
| 跨教师隔离:项目/版本/任务/消息/图片/下载/对话/删除一律 404,防枚举,列表互不可见 | 集成 | ✅ | test/integration/isolation.test.ts | — |
| 聊天 SSE 全链路:事件契约、落库 complete、usage/request_id、幂等重放(不再调上游)、stop(D1 信号,部分内容保留)、edit_of 分支、不可用模型 400 | 集成 | ✅ | test/integration/chat.test.ts | 上游为 mock |
| 大负载:2/5/10/20MB b64 → 解码 → R2 → D1 | spike(workerd) | ✅ 本地 | spikes/gateA-bigpayload.mts | **线上 10ms CPU 限额未验证——首要实测项** |
| 前端 Markdown/XSS、e2e 浏览器、iPhone Safari | — | **未运行** | — | 需浏览器环境与真机,列为下阶段 |
| 真实 12 教师并发、30/50 用户压测、真实 120s 长流 | — | **未运行** | — | mock 延迟已覆盖状态机,真实吞吐待线上 |
| Cloudflare Free 实测(CPU/R2/D1/Queues 真实额度) | — | **未验证** | — | 需账户授权;不得标"已通过" |

## 3. 仓库安全检查

- [x] `git grep`/文件扫描:新项目内无真实教师姓名/邮箱/学校 IP/密钥(教师白名单仅存在于原项目,未复制);
  集成测试全部使用 `@example.edu` 占位邮箱与虚拟姓名。
- [x] `.gitignore` 排除 `.dev.vars`、`wrangler.jsonc`、`config/grade.json`、真实名单 CSV、备份目录。
- [x] 交付模板(config/*.example、*.template.csv)仅含占位符。

## 4. 原项目完整性(防篡改)

- 开始工作前对 `D:\project\english-workbench` 生成 131 文件清单快照
  (`_audit/original-manifest-v1.6.1.txt`:路径|大小|mtime)。
- 结束后复核比对(见最终交付回复):**原项目零修改**。

## 5. 未完成与未验证汇总

1. 浏览器端 PDF/DOCX 解析(闸门 D 核心缺口)——前端附件解析器未上线。
2. 缩略图浏览器端生成上传;前端轮询退避(3–5s 起步)。
3. Cloudflare Free 线上实测(全部六闸门的线上部分);真实邮件发送;真实 AI 上游编辑链路。
4. e2e 浏览器测试与移动端真机验收。
