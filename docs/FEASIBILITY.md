# FEASIBILITY — Cloudflare Free 可行性闸门报告

状态标注口径:**本地通过**(本地 workerd/Node 可复现)/ **Cloudflare Free 实测通过**(需授权后真实账户验证)/ **未验证** / **已失败**。
截至本文,未获得任何 Cloudflare 账户授权,因此**没有任何项可标注"Cloudflare Free 实测通过"**。

## 测试方法

本地验证使用 wrangler `getPlatformProxy`(miniflare workerd)——与生产**同一运行时**,
提供真实的 D1(SQLite)、R2 对象存储、Queue producer 绑定。测试代码见
`apps/worker/test/`(67 项断言)与 `spikes/gateA-bigpayload.mts`。

## 闸门 A|图像生成与存储 — **本地通过(流水线化) / 线上未验证**

**P0 重大更新(2026-11-07)**:图像交付重构为**字节级分阶段流水线**,
不再有任何单次调用处理整图:

```
start(响应体透传 R2 分块,CPU≈I/O)
  → scan(1MB 字节级窗口扫 marker,b64 字节直拷分块对象)
  → decode(500K 字符 atob 分片,每片实测 ≈5-8ms Node 量级)
  → assemble(分块串流合成,纯 I/O)
```

- spike(gateA-bigpayload.mts):2/5/10/20MB 全链路字节一致,队列调用 5/9/15/29 次;
- 对照:旧实现(整体 JSON.parse + atob)在 7M 字符时实测 122ms CPU —— 免费套餐必挂,
  这就是必须流水线化的实证;
- URL 模式:上游返回 url 时全程无 base64,同源白名单 + 分块拷贝(CPU≈I/O);
- 小图(≤500K b64 字符):扫描完成后单次解码快速路径。

| 验证点 | 结果 |
|---|---|
| 2/5/10/20MB 流水线端到端字节一致 | ✅ 本地 workerd |
| 三路径交付(inline/staged/url)集成测试 | ✅ |
| R2 分块合成(流式 + Node 回退) | ✅ |
| **每阶段真实 CPU(10ms 限额)** | **待线上实测** — `spikes/live-cpu-probe/` 已备好,含三通道(HTTP/Queue/Cron)采集手册与判定表 |
| 内存峰值 | 单次调用仅 ~1-2MB 切片;线上峰值待观测 |

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

## 闸门 D|文档和图片附件 — **已实现(浏览器端解析)/ 线上未验证**

P1 完成:PDF/DOCX/TXT 正文在**浏览器端**抽取(pdf.js 逐页、mammoth、上限 60 页 /
60,000 字符,截断如实标记 text_truncated),随表单提交;服务端限长并存储。
图片附件经 canvas 重编码(EXIF/GPS 不离开浏览器),对话附件缩到模型输入长边 1568px,
参考图保持原分辨率(canvas 上限约 24MP,超出给可读错误)。
扫描件无文本时服务端如实提示,不假装读过。
**待验证**:浏览器解析在真实设备上的表现(pdf.js 大文件);线上端到端。

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
