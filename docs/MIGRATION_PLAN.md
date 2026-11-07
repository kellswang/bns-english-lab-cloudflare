# MIGRATION_PLAN — 迁移计划与当前进度

## 原则

1. 单代码库、每年级一份独立单租户部署;绝不做跨年级共享数据库。
2. 先可行性闸门,后移植;本地 mock/workerd 通过 ≠ 线上通过,逐项如实标注。
3. 原项目(`english-workbench` v1.6.1)只读基准;ZIP(v1.5.4)仅参考。

## Phase 0 — 审计与闸门 ✅(本地部分)

- [x] 全源码审计(后端精读 + 前端/外围两路并行审计)→ SOURCE_AUDIT.md
- [x] 六闸门本地验证 → FEASIBILITY.md(A/B/C/E 本地通过;D 部分;F 模板就绪)
- [x] 原项目文件清单快照(131 文件,防篡改基线)

## Phase 1 — 新工程 + D1 + 身份 + 资源隔离 ✅(本地)

- [x] Monorepo 骨架(apps/worker + apps/web + db + config + docs + spikes)
- [x] D1 迁移 0001(15 张表,含全部唯一索引)
- [x] JWT 会话 + OTP 发码/核销 + 白名单 + 管理员
- [x] 项目/消息/版本/文件路由 + R2 私有存储
- [x] 集成测试(workerd 真实 D1/R2):认证 8、隔离 5

## Phase 2 — AI 对话完整迁移 ✅(本地,mock 上游)

- [x] 三家原生协议适配器 + 4 档思考映射
- [x] SSE 全链路(事件契约与前端逐字段对齐)
- [x] 分支(edit_of/regenerate_of/activate)、历史压缩摘要 + SummaryCall 对账记录
- [x] 幂等重放、跨实例 stop(D1 信号)
- [ ] 浏览器端 PDF/DOCX 正文抽取(PDF.js / mammoth)——**唯一未完成项**
- [ ] 前端附件上传改为"浏览器解析 + 正文随表单提交"

## Phase 3 — 图片生成完整迁移 ✅(本地)/ 🟡 收尾项

- [x] Queues 状态机 8 态、原子领取、重复投递幂等
- [x] 15 画幅原生 2K、版本树(parent/source_version_id)、快照单价
- [x] uncertain/pending_save 语义、sweep 巡检 Cron、孤儿对象清理路径
- [ ] 前端轮询退避(1600ms → 3-5s 起步退避)+ 缩略图浏览器端生成上传
- [ ] 线上 CPU 实测后决定是否需要分块/URL 模式(见 FEASIBILITY 备选路线)

## Phase 4 — 生产加固与多年级分发 🟡

- [x] 部署手册 DEPLOY_GRADE.md、备份恢复 BACKUP_AND_RESTORE.md、升级回滚 UPGRADE_AND_ROLLBACK.md
- [x] 成本模型 COST_MODEL.md、测试报告 TEST_REPORT.md
- [x] 配置模板(grade.example.json / teachers.template.csv / wrangler.jsonc.example / .dev.vars.example)
- [x] scripts/(资源初始化、白名单导入、部署前检查)
- [ ] 授权后的 Cloudflare Free 实测(六闸门线上部分)
- [ ] 前端 390px/Safari 实机验收(需真机)

## 关键实现决策与理由

| 决策 | 理由 |
|---|---|
| Hono 路由 + 手写 JWT(WebCrypto) | Workers 原生、依赖极少;JWT 逻辑 60 行可测试,避免 PyJWT 类依赖 |
| job 行即 outbox | D1 先落 job(queued),Cron 每 5 分钟重投 30s 以上未入队的任务;重复投递被原子领取挡住,无需单独 outbox 表 |
| R2 键含 versionId(UUID)而非版本号 | 版本号唯一冲突重试时无需重写 R2 对象 |
| stop 用 D1 列而非 KV/DO | 与消息同库同事务,免费额度内;KV 最终一致不适合,DO 属额外复杂度 |
| 时间 TEXT(naive UTC) | 与原前端 parseServerTime 契约一致,避免全站时间错 8 小时 |
| 每实例 Cookie 名带 GRADE_ID | 同一浏览器并行登录多个年级实例不互踢 |
