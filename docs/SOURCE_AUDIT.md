# SOURCE_AUDIT — 原源码 → Cloudflare 实现对照表

基准:**本地项目 `english-workbench` v1.6.1**(2026-11-06,CHANGELOG 最新),
原项目只读未动(文件清单快照见 TEST_REPORT 附录)。ZIP(v1.5.4)仅作版本对照参考。

图例:✅ 已实现且有自动化测试 | 🟡 已实现,部分依赖规划中的前端配合 | ⬜ 未迁移(见说明)

## 后端

| 原文件 | 原行为 | Cloudflare 新实现 | 自动化测试 |
|---|---|---|---|
| `app/models.py` | 15 张表(SQLAlchemy) | `db/migrations/0001_init.sql` 逐表翻译 + `stop_requested` 新列(跨实例停止信号) | 集成测试全链路 |
| `app/config.py` | pydantic-settings 环境变量 | `src/config.ts` wrangler vars + secrets;生产缺密钥拒绝启动 | config 单元语义包含在集成测试 |
| `app/security.py` | PyJWT HS256 + HMAC 验证码摘要 | `src/auth/tokens.ts` WebCrypto HS256(alg 混淆防护)+ HMAC 摘要 | `test/unit/tokens.test.ts` 7 项 |
| `app/email_auth.py` | 白名单发码/原子限流/单次核销 | `src/auth/emailAuth.ts` 同规则,D1 UPSERT/条件 UPDATE | `test/integration/auth.test.ts` 8 项 |
| `app/teachers.py` | ROSTER 播种(13 名真实教师) | **不移植名单**;白名单由各年级 CSV 模板初始化(`scripts/import-teachers.mjs`) | 隔离测试 |
| `app/worker.py` | ThreadPoolExecutor + 8 态状态机 | `src/queues/imageConsumer.ts` Queues 消费者,原子领取/version_seq 原子取号/R2 写盘/分支命名 MAIN+B 系列 | `test/integration/generation.test.ts` |
| `app/image_provider.py` | httpx + Pillow 规范化/缩略图/SSRF 防护 | `src/providers/imageGateway.ts`(b64/URL 双模式、uncertain 语义、SSRF 白名单);**无 Pillow**:不做像素规范化,尺寸异常如实记录;缩略图浏览器端(🟡) | 单元 + spike(20MB) |
| `app/chat/service.py` | 上下文预算/摘要/流式编排/进程内 stop | `src/chat/service.ts` 同预算算法;stop 改 D1 列 | `test/unit/chatBudget.test.ts`、集成 5 项 |
| `app/chat/capabilities.py` | 8 模型白名单(1 不可用)、4 档思考 | `src/chat/capabilities.ts` 逐字段翻译,不静默替换 | 集成:不可用模型 400 |
| `app/chat/billing.py` | 常驻 asyncio billing_loop | `src/cron/reconcile.ts` Cron 每 15 分钟,同口径(pending/verified/unavailable、退避、金额校验) | 逻辑同构,未单独测(需真实账单接口) |
| `app/chat/attachments.py` | 服务端 pypdf/python-docx 解析 | 服务端只做魔数/大小/限长 + 存储;**PDF/DOCX 正文抽取迁移到浏览器端(⬜ 前端解析器未上线)** | 服务端校验部分已测 |
| `app/chat/providers/*` | 三家原生协议(OpenAI/Anthropic/Gemini) | `src/chat/providers/*` 逐家翻译,事件语义/思考映射/usage/request_id 一致 | `test/unit/providers.test.ts` 7 项 |
| `app/main.py` | lifespan 恢复/安全头/CSRF/HEAD | `src/index.ts` fetch/queue/scheduled 三入口;Origin 校验 + 安全头;HEAD 由 Static Assets 层处理 | health 集成测试 |
| `app/api/{auth,projects,generation,files,usage,admin,chat}.py` | REST 路由 | `src/routes/*` 同路径同响应字段(见 API_COMPATIBILITY.md) | 集成测试 24 项 |
| `app/api/deps.py` | 会话/权限/审计(仅 owner,越权 404) | `src/auth/deps.ts` 同语义;IP 改用 CF-Connecting-IP | `test/integration/isolation.test.ts` |
| `app/migrate.py`、`cli.py` | schema_migrations + CLI 运维 | D1 migrations(文件即迁移)+ wrangler d1 execute;CLI 运维由 wrangler 命令替代 | helpers 幂等应用迁移 |

## 前端(整体复用,不重做 UI)

| 原文件 | 处理 |
|---|---|
| `src/views/`、`src/components/`、`src/styles/`、`public/media/` | **原样复制**(robocopy,39 文件),暖纸色 Claude 风格、登录视频、移动端断点全保留 |
| `src/stores/chat.ts` | 原样保留:SSE 事件契约(start/delta/meta/error/finish/[DONE])与 Worker 实现逐字段对齐;取消走 AbortController + 服务端 stop |
| `src/stores/workspace.ts` | 原样保留(POLL_MS=1600 轮询)。**规划**:按提示词第 7.7 条改为 3–5 秒起步退避(Phase 3 收尾项,见 MIGRATION_PLAN) |
| `src/utils/datetime.ts` | 原样保留;后端维持 naive UTC 契约,北京时间展示不变 |
| `vite.config.ts` | 仅改 dev 代理端口 8000→8787(wrangler dev) |

## 明确保留的"来源行为"清单

- 星标按钮已下线:`/versions/{id}/star` 端点保留兼容,UI 无恢复。
- 项目共享已下线:`project_shares` 表保留,权限仍仅 owner。
- 空白对话/创作不落库:前端行为原样,后端无"新建即建行"路径。
- 费用展示:图片 $0.02/张快照单价,对话按上游核对金额;无"剩余额度"。
- 时间:UTC 存储 + naive UTC 契约,展示北京时间。
- `claude-fable-5-5` 保留不可用标记,不替换。
