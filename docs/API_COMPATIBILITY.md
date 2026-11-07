# API_COMPATIBILITY — 前后端契约对照

所有路径以 `/api/v1` 为前缀,响应错误体 `{"detail": ...}`(字符串或含 reason 的对象),
时间字段为 **naive UTC ISO 字符串**(管理页日志为北京时间 ISO +08:00)。
来源核对基准:`frontend/src/types.ts` + 原 `backend/app/api/*.py`。

## 认证

| 端点 | 状态 | 说明 |
|---|---|---|
| GET `/auth/config` | ✅ | app_name/brand/tagline/email_domain/session_days/provider |
| POST `/auth/email/code` | ✅ | 202;dev 环境无 RESEND key 时返回 dev_code(生产禁用);429 带 Retry-After |
| POST `/auth/email/verify` | ✅ | UserOut + HttpOnly Cookie(名含 GRADE_ID);trust_device → 30 天 rmb 会话 |
| POST `/auth/logout` | ✅ | 清 Cookie |
| GET `/auth/me` | ✅ | UserOut;停用 403 |

## 图片创作

| 端点 | 状态 | 说明 |
|---|---|---|
| GET `/models` | ✅ | items(2 模型)/default/size_presets(15 项,pixels `1456×2048` 全角×,含 native_width/height)/default_size=a4/quality=2K/output_long_edge |
| POST `/uploads` | ✅ | FormData(project_id+file)→ {id,url,filename};魔数校验;413>12MB |
| POST `/generate` | ✅ | 202 {job_id,message_id,status,version_id,deduplicated};幂等键 replay 也返回 202;同键异参 409 idempotency_key_reused;不支持编辑 409 model_no_edit;容量 429/503 |
| GET `/jobs/:id` | ✅ | 8 态 + version_no;404 非本人 |
| GET/POST `/projects`、GET/PATCH/DELETE `/projects/:id` | ✅ | 仅 owner;软删除;has_images;搜索 LIKE |
| GET `/projects/:id/messages` | ✅ | items 含 meta(JSON)|
| GET `/projects/:id/versions` | ✅ | versionOut 全字段含 url/thumb_url/params |
| GET `/projects/:id/jobs` | ✅ | 最近 10 条 |
| GET `/versions/:id`、PATCH `/versions/:id/star` | ✅ | star 仅历史兼容 |
| GET `/versions/:id/image\|thumb\|download` | ✅ | 归属校验后 R2 流式;thumb 缺失回退原图;下载 Content-Disposition `BNS_{标题≤48}_v{NNN}.png` |
| GET `/uploads/:id/image` | ✅ | 参考图 |
| GET `/usage` | ✅ | images/amount_usd/chat_amount_usd/chat_pending/total_usd/unit_price_usd/scope/basis/note;快照单价口径 |

## AI 对话

| 端点 | 状态 | 说明 |
|---|---|---|
| GET `/chat/models` | ✅ | 8 模型 + usage_basis;`claude-fable-5-5` status=unavailable 保留 |
| GET/POST `/chat/conversations`、GET/PATCH/DELETE `/:id` | ✅ | 列表含 message_count + preview(窗口函数)|
| POST `/chat/conversations/:id/messages` | ✅ | SSE:`data: {json}\n\n` 帧,start/delta/meta/error/finish + `[DONE]`;edit_of/regenerate_of/client_request_id 幂等重放 |
| POST `/chat/messages/:id/stop` | ✅ | 写 D1 stop_requested(跨实例)|
| POST `/chat/messages/:id/activate` | ✅ | 切分支至最深子孙 |
| POST `/chat/conversations/:id/attachments` | ✅ | 🟡 表单额外接受 extracted_text/page_count/text_truncated(浏览器端解析,见 FEASIBILITY 闸门 D)|
| GET `/chat/attachments/:id/file` | ✅ | 归属校验,inline |
| GET `/chat/usage` | ✅ | token 聚合(json_extract SQL)|

## 管理(只读)

| 端点 | 状态 | 说明 |
|---|---|---|
| GET `/admin/overview` | ✅ | users(逐师图片张数/快照价金额/chat verified+pending)/totals;时间北京时间 ISO |
| GET `/admin/logs` | ✅ | limit/offset/email/action 过滤 + actions 字典;LEFT JOIN users 取 actor_name |
| GET `/health`、`/health/live` | ✅ | DB 异常 503 |

## 与原实现的已声明差异

1. **Version.width/height**:原为 Pillow 解码值;新实现取上游声明尺寸(`size` 字段),
   上游未声明时为 null(前端以 `params.model_native_px`/`output_px` 为准,类型允许 null)。
2. **缩略图**:原服务端 JPEG 420px;新实现 thumb 缺失时回退原图,浏览器端生成上传为规划项。
3. **`/generate` 幂等 replay** 原返回 200(装饰器 202 仅作用于新建路径语义上仍是 202);
   新实现统一 202(与原 FastAPI `status_code=202` 行为一致)。
4. **附件上传**新增可选表单字段(向后兼容;原字段不变)。
5. `/api/v1/auth/email/code` 422→400:Pydantic 422 校验改为显式 400(前端按 detail 文案展示,无影响)。
