# FEASIBILITY — Cloudflare Free 可行性闸门报告

状态标注口径:**本地通过**(本地 workerd/Node 可复现)/ **Cloudflare Free 实测通过**(需授权后真实账户验证)/ **未验证** / **已失败**。
截至本文,未获得任何 Cloudflare 账户授权,因此**没有任何项可标注"Cloudflare Free 实测通过"**。

## 测试方法

本地验证使用 wrangler `getPlatformProxy`(miniflare workerd)——与生产**同一运行时**,
提供真实的 D1(SQLite)、R2 对象存储、Queue producer 绑定。测试代码见
`apps/worker/test/`(67 项断言)与 `spikes/gateA-bigpayload.mts`。

## 闸门 A|图像生成与存储 — **本地通过 / 线上未验证**

| 验证点 | 结果 | 证据 |
|---|---|---|
| 大体积 b64 响应解码 → R2 写入 → D1 版本落库 | 2/5/10/20 MB 全部成功,字节精确一致,耗时 0.6~1.9s | `spikes/gateA-bigpayload.mts` 输出 |
| R2 流式写入约束 | 实现 FixedLengthStream 路径;测试覆盖 ArrayBuffer 路径 | `src/storage/r2.ts` |
| 上游 URL 模式 | 仅允许 AI_BASE_URL 同域 + https + 禁止重定向 + 25MB 上限 | `src/providers/imageGateway.ts`;SSRF 测试在单元层 |
| 15 画幅 / 原生 2K | 逐项参数化测试通过(2048×2048、1456×2048、2048×1536、2048×1152…) | `test/unit/sizes.test.ts` 19 项 |
| 队列状态机(queued→submitted→running→succeeded;失败/uncertain/pending_save) | 集成测试:成功产出版本 V1;重复投递不产第二个版本;上游 5xx → uncertain 且只调一次上游 | `test/integration/generation.test.ts` |
| 缩略图 | **降级方案**:无 Pillow,服务端不做像素处理;缩略图由浏览器端生成后经受控接口上传(规划),缺失时 thumb 接口回退原图 | `src/routes/files.ts`;风险见下 |
| **风险(必须线上实测)** | ① Workers Free **10ms CPU/请求**:20MB 级 JSON 解析 + base64 解码在本地 workerd 耗时秒级,但 workerd 本地无 CPU 限额;线上若超 10ms 会失败,需 Queues consumer 实测(消费器同样受 CPU 限额)与可能的分块处理。② 128MB 内存:base64 字符串 ≈ 字节的 1.37 倍,20MB 图 ≈ 47MB 峰值(字符串+解码缓冲),本地未触顶;更大尺寸需实测。③ 免费 CPU 额度对 `/images/edits` multipart 大原图纸上传的影响 | 待 Cloudflare Free 授权实测 |

**结论**:逻辑与数据通路在本地 workerd 全部可行;**线上 CPU 限额是唯一硬未知项**,
属"无法在本地证明/证伪"的部分。若线上实测失败,备选路线见文末。

## 闸门 B|原图编辑真实性 — **本地通过(mock 上游)/ 真实上游未验证**

- edit 路径从 R2 读取真实源图字节,以 multipart(`image` / `image[]`,≤4 参考图)提交 `/images/edits`;
  同项目归属校验 + R2 对象存在性校验(缺失 → 410)。
- 队列重复投递经原子领取(条件 UPDATE,changes=1 才调上游)保证只执行一次付费修改。
- `supports_edit=false` 的模型在 API 层直接 409,绝不静默降级为 generate(集成测试覆盖模型白名单 400 分支;409 分支与原实现同构)。
- **未验证**:真实上游对 multipart 的接受度与 2K 编辑质量(需真实 AI 网关密钥)。

## 闸门 C|AI 对话 SSE — **本地通过**

- 三家原生协议适配器(OpenAI Responses / Anthropic Messages / Gemini streamGenerateContent)
  用 fixture 流逐事件断言:delta 顺序、usage 字段、request_id 口径(响应头优先,厂商 id 兜底,
  Gemini 流末补发 meta)、thinking_delta 不下发、error 事件中断。
- SSE 解析器跨 chunk UTF-8 多字节、半截行安全(单元测试)。
- 端到端集成(真实 workerd D1):start/delta/finish 事件、落库 complete、usage/request_id 持久化、
  幂等重放(不重复调用上游)、edit_of 分支、**跨实例 stop**(D1 stop_requested 信号 + 流内轮询,
  部分内容保留,状态 stopped/complete 如实)。
- **未验证**:真实 120 秒级长流在 Workers Free 的 CPU 计费(流式等待上游不计 CPU,
  但分块 JSON 解析计费)。

## 闸门 D|文档和图片附件 — **部分本地通过 / 浏览器端解析未实现**

已实现(服务端):魔数嗅探(PNG/JPEG/WebP/PDF/ZIP)、20MB 上限、40MP 头部尺寸预检、
R2 私有存储 + 会话归属下载、文本 60,000 字符截断标记、孤儿对象清理。
**浏览器端 PDF/DOCX 正文抽取(PDF.js / mammoth)尚未实现**——当前方案为客户端随表单提交
`extracted_text`(服务端限长、记录 text_truncated)。这是与原项目(服务端 pypdf/python-docx)
的一个**已声明的差距**:在浏览器端实现完成前,PDF/DOCX 正文抽取依赖前端解析器上线。
扫描件无文本的诚实提示逻辑已保留(不假装读过)。
EXIF 清除:参考图由浏览器端重编码(规划);当前服务端只做魔数校验,不重编码。
**此项为迁移的核心未完成项之一**,不宣称功能等价。

## 闸门 E|验证码和会话 — **本地通过**

- D1 存储 HMAC-SHA256 摘要(不存明文)、5 分钟/单次/5 次/60 秒冷却/每邮箱 10 封时/每 IP 30 封时,
  原子 UPSERT + 条件 UPDATE 实现并发安全(集成测试:白名单外 403 且不写记录、错 5 次 429、
  单次核销、冷却 429)。
- 会话 JWT HS256(iss 校验、alg 混淆防护、rmb 30 天/1 天)、停用立即 403、管理员按 ADMIN_EMAILS 提权。
- IP 只取 Cloudflare 注入的 `CF-Connecting-IP`(不信任 X-Forwarded-For/X-Real-IP);
  学校出口 IP 豁免走实例配置(模板不含真实 IP)。
- Resend 调用已实现(真实发信未验证,需各实例独立 RESEND_API_KEY + 域名验证——**这是
  Cloudflare 之外的前置条件,不是免费额度问题**)。

## 闸门 F|每个年级独立部署 — **模板就绪 / 跨账户实测未验证**

- 每实例独立:Worker 名、D1、R2、Queue、Cron、Cookie 名(含 GRADE_ID 后缀)、
  SESSION_SECRET/OTP_SECRET/RESEND_API_KEY/AI_API_KEY、年级显示名与白名单。
- `wrangler.jsonc.example`、`config/grade.example.json`、`config/teachers.template.csv`
  全部为占位符;仓库经安全检查不含真实姓名/邮箱/密钥(见 TEST_REPORT)。
- 跨账户部署演练需各年级负责人账户,未验证。

## 总结论

| 闸门 | 本地 | 线上(Free) |
|---|---|---|
| A 图像 | 通过(mock + workerd) | **未验证(CPU 限额是关键未知项)** |
| B 编辑 | 通过(mock) | 未验证 |
| C SSE | 通过 | 未验证 |
| D 附件 | 部分(浏览器解析未实现) | 未验证 |
| E 认证 | 通过 | 未验证(Resend 发信未实测) |
| F 隔离 | 模板就绪 | 未验证 |

## 若 Free CPU 实测失败的备选路线(供决策,未擅自采用)

1. **精简处理逻辑**:图像上游改用"URL 返回模式"(上游存图,Worker 只流转 key),
   避免大 base64 解码;缩略图全部浏览器端生成。核心功能不丢,改动集中在 provider 层。
2. **Cloudflare 低价付费**:Workers Paid($5/月起)解锁 30s CPU/请求与更高队列额度,
   单实例年成本 ≈ ¥450;可在完全验证 Free 失败后仅对生图实例启用。
3. **混合方案(需明确授权)**:生图任务保留在现有服务器,聊天/认证/文件迁 Cloudflare;
   两个系统经内部 token 通信。维护成本最高,不推荐,仅作兜底。
