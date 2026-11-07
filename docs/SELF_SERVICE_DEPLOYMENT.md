# Cloudflare 免费套餐自助部署（测试版）

> 本指南基于 \`dev/round3-hardening\` 的第三轮修复代码。目标是每年级一份独立 Cloudflare 账户、独立数据库与文件存储。  
> **状态：部署脚本初版，尚未用新 Cloudflare 账户做端到端真实部署验证。请先使用测试账户；不要宣传为已验证的一键部署。**

## 一、年级负责人需要提供什么？

| 材料 | 是否必须 | 安全要求 |
|---|---|---|
| TeamoRouter API | 是 | 兼容的 AI API Base URL + API Key；允许单 Key 同时做聊天和生图，也允许两个 Key |
| 教师姓名和邮箱 | 是 | \`real_name,email\` CSV，**保存在仓库之外**；至少一位管理员也必须在名单中 |
| Cloudflare 账户和授权 | 是 | 已注册账户；OAuth 或受限 \`CLOUDFLARE_API_TOKEN\` + \`CLOUDFLARE_ACCOUNT_ID\`，不要 Global API Key |
| Resend 邮件服务 | **是，当前登录功能依赖** | 已验证发件域名、发件邮箱、Resend API Key |
| 年级标识及学校邮箱域名 | 是 | \`grade.json\`，没有私钥；决定教师登录域名规则 |
| 自定义域名 | **否** | 可以先用自动分配的 \`workers.dev\`；需要自定义域名时必须已接入相同 Cloudflare 账户的 Zone |

**与原先“四项材料”的区别：** 用户不一定需要自备网站域名，但必须有能够给教师发送验证码的邮件服务。Cloudflare API Token 不是信用卡，不能替用户完成 R2 付款方式验证。

## 二、首次使用必须手动完成的步骤

1. 注册并登录 Cloudflare，启用账户安全验证。Workers 不需要用户预先创建一个空项目。
2. 在 Cloudflare 控制台 Storage & databases → R2 → Overview **开通 R2 subscription**。这一步可能要求持卡人自行完成支付方式/结账验证，不要把信用卡信息交给 Agent。R2 有免费额度，超出可能计费。
3. 在 Resend 账户上完成发件域名 DNS 验证。若使用学校邮箱域名，应由学校负责域名 DNS 的管理员操作；不要自行更改学校现有 MX 或邮件生产配置。
4. 准备 Cloudflare 授权。对个人终端最简单是 \`npx wrangler login\`；对 Agent/自动化，使用**仅针对目标 Cloudflare 账户和所需服务**的 Scoped API Token。初次创建 D1/R2/Queues/Workers 需要创建权限，后续升级应轮换为权限更小的部署 Token。
5. *可选*：若要自定义域名，先让该域名处于本人 Cloudflare 账户的活动 Zone；部署程序可以把 Worker 绑定到该域名，但不负责域名注册商的 NS 迁移或破坏性 DNS 修改。若域名未接入，可先保留 \`custom_domain: ""\`。

Cloudflare 官方参考：
- https://developers.cloudflare.com/r2/get-started/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

## 三、部署者本机的三个输入

**1. 非密钥配置：** 将 \`config/grade.example.json\` 复制为 \`config/grade.json\`，填写 \`grade_id\`、\`grade_label\`、\`school_name\`、\`email_domain\`、\`admin_emails\`、\`resend_from_email\`、\`ai_base_url\`、\`chat_base_url\` 等。

- 没有独立域名：\`"custom_domain": ""\`。
- 已接入 Cloudflare 的自定义域名：\`"custom_domain": "lab.example.edu"\` 和 \`"confirm_zone_connected": true\`。首次部署不建议绑定学校主域名。
- \`grade_id\` 每账户内保持唯一，例如 \`g3\`、\`g4\`。
- 真实配置只存在本机，严禁提交到公共 GitHub。

**2. 教师名单 CSV：** 在**仓库之外**创建私有文件 \`teachers.csv\`，格式：

~~~csv
real_name,email
示例教师一,teacher1@example.edu
示例负责人,admin@example.edu
~~~

将上述示例邮箱换为实际的学校邮箱，且把管理员邮箱也填入 \`admin_emails\`。目前解析器只支持简单两列 CSV（姓名不能包含逗号）。名单可能包含个人资料，需按学校的授权与数据管理要求保管。

**3. 私有环境变量：** 用终端或操作系统安全的密钥管理机制设置：

~~~text
TEAMOROUTER_API_KEY=（真实 Key）
RESEND_API_KEY=（真实 Key）
CLOUDFLARE_ACCOUNT_ID=（对应年级 Cloudflare 账户 ID）
CLOUDFLARE_API_TOKEN=（仅部署所需权限的 Scoped Token）
~~~

可选 \`CHAT_API_KEY\`：如果聊天和生图采用不同网关或不同密钥。若已经通过 \`wrangler login\` 登录，可以不提供 Cloudflare API Token，但仍须确认操作目标是正确账户。不要把上述真实值复制到 GitHub Issue、Pull Request、公开聊天或本仓库。

## 四、预览与执行

在仓库根目录安装 Node.js（推荐当前 LTS 版本），然后：

~~~bash
npm ci
node scripts/deploy-grade.mjs --teachers /private/path/teachers.csv
~~~

第二条命令是**预览模式**，仅校验年级资料和教师名单，不创建云端资源。确认 Cloudflare 账户、R2、Resend 已经开通，且确实是正确年级账号后：

~~~bash
node scripts/deploy-grade.mjs --teachers /private/path/teachers.csv --apply
~~~

脚本计划顺序：

1. 校验配置、教师名单、API Key 是否齐备；已有实例的 \`wrangler.jsonc\` 会被阻止覆盖。
2. 检查 Wrangler 登录与依赖环境。
3. 创建该年级的 D1、R2、Queues/DLQ，生成实例配置，执行数据库迁移。
4. 为该年级的 Worker 批量注入 Secrets；Session/OTP 随机密钥写入本机受忽略的 \`config/deploy.runtime.local\`，请安全备份；Windows 还需注意文件 ACL。
5. 导入教师白名单、构建前端。
6. 部署 Worker 与静态资源，并显示 Wrangler 输出的默认访问地址。

**注意：** 脚本不会自动支付、开通 R2、验证 Resend 域名、登录用户的 Cloudflare 主账户，也不会触发真实付费 AI 图片生成。云端创建本身可能对目标账户产生资源/用量影响，因此必须由用户明确输入 \`--apply\`。

### 已有实例、失败与重试

此脚本只用于**第一次部署**。如本地已经存在 \`apps/worker/wrangler.jsonc\`，会拒绝再次初始化，以避免意外修改已有生产实例。初次创建资源时若在中间失败，**不要直接删库或强制覆盖**；先使用 \`wrangler d1 list\`、R2/Queues 列表核对已创建资源，按现有 \`docs/DEPLOY_GRADE.md\` 的分步骤方式恢复，或让技术人员协助。后续升级使用 \`docs/UPGRADE_AND_ROLLBACK.md\`。

**重要限制**：\`scripts/new-grade.mjs\` 的现有幂等逻辑仍需要真实新账户测试，尤其是 D1 创建结果解析和已有资源恢复。新引导脚本不是升级脚本，也没有自动回滚整个云端创建事务。

## 五、发布后的验收清单

- [ ] \`/api/v1/health\` 正常，Vue 页面与学校邮箱后缀显示正确。
- [ ] 名单外邮箱无法请求验证码，名单内教师实际收到 Resend 邮件并登录。
- [ ] 教师只能看到自己的项目，管理员入口只对负责人开放。
- [ ] AI 对话 SSE 和 PDF/DOCX 附件正文提取正常。
- [ ] 生图、下载、缩略图与 V1→V2 的图片编辑版本树正常（真实 AI 调用会产生上游费用）。
- [ ] Cloudflare Dashboard 检查 Workers CPU/错误率、Queues 消息数、D1 行读写和 R2 存储。
- [ ] 真实年级名单和 API Keys 没有出现在 Git 暂存区或任何部署日志中。
- [ ] 备份恢复与升级流程明确；每个年级账户数据互相隔离。

**站点无需强行绑定域名即可验收。** Cloudflare 文档建议长期正式站点使用 Custom Domain，但初次演练可以先用 \`workers.dev\`。

## 六、公开前置条件与维护边界

本仓库即使以后公开，也只应公开代码、非敏感配置模板与教程。真实教师名单、AI Key、Cloudflare Token、Resend Key、管理员资料和学校教学数据必须保存在部署方的私有环境。**公开 GitHub 并不等于学校名称、图片、教材或登录视频拥有再分发许可。**

正式改为 Public 前，必须完成 \`docs/PUBLIC_RELEASE_CHECKLIST.md\`。本文件和新增引导程序尚未经过新账号实际部署验收，请把完成状态标记为“待测试”。
