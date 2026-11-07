# 年级负责人 15 分钟部署检查表(非技术版)

> 每一步做完打个勾;卡住时把红色报错截图发给技术支持。
> 真实耗时未经验证(标:待验证);Resend 域名验证可能要等几小时,建议提前做。

## A. 准备(开始前要有)
- [ ] 自己的 Cloudflare 账户(免费套餐即可;开通 R2 需绑一张银行卡,**免费额度内不扣钱**)
- [ ] Resend 账户,并完成发件域名验证(这是邮件平台要求,不是 Cloudflare 的)
- [ ] 图像 API 与对话 API 的网关地址 + 密钥(本年级独立计费)
- [ ] 本年级教师名单 CSV(格式:`real_name,email`,表头必须有;**用真实名单,别用模板里的占位**)
- [ ] 电脑装有 Node.js 20+

## B. 初始化(全自动,约 5 分钟:待验证)
- [ ] 复制 `config/grade.example.json` 为 `config/grade.json`,填写年级名/域名/管理员邮箱
- [ ] 命令行进入项目目录,运行 `node scripts/new-grade.mjs --apply`
      → 自动创建 D1 / R2 / 队列,生成 `apps/worker/wrangler.jsonc`,完成建表
      → 如提示 `PASTE_DATABASE_ID`,把命令输出里的 database_id 填进该文件再运行一次

## C. 密钥(5 条命令)
- [ ] `npx wrangler secret put SESSION_SECRET`(值用 `openssl rand -hex 32` 生成;Windows 可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] 同法设置 `OTP_SECRET`、`RESEND_API_KEY`、`AI_API_KEY`、`CHAT_API_KEY`

## D. 名单与部署
- [ ] `node scripts/import-teachers.mjs 名单.csv --apply`(先不带 --apply 预览一遍)
- [ ] `cd apps/web && npm install && npm run build`
- [ ] `cd ../worker && npx wrangler deploy` → 输出里的 workers.dev 地址就是本年级入口

## E. 上线验收(每项通过才算完成)
- [ ] 打开入口地址 → 登录页出现,视频正常播放
- [ ] 名单外邮箱请求验证码 → 提示"未获得使用权限",收不到邮件 ✓
- [ ] 名单内邮箱 → 收到验证码 → 登录成功,右上角显示教师姓名
- [ ] 新建 AI 对话 → 流式回答正常;上传一份 PDF/DOCX → 提问能答出文档内容
- [ ] 新建图片创作 → 生成 1 张 → 出图、可下载、版本轨出现 V1
- [ ] 管理入口(仅负责人)→ 汇总数字正常
- [ ] `npx wrangler d1 execute bns-elab-<年级>-db --remote --command "SELECT 1"` 正常

## F. 日常
- [ ] 每周:`node scripts/backup-d1.mjs <年级>`(导出数据库到 backups/)
- [ ] 每月:Dashboard 看用量;管理页"站内估算"超 7GB 时按手册归档旧作品
- [ ] 升级:按 `docs/UPGRADE_AND_ROLLBACK.md`(先备份 → git pull → 构建部署 → 健康检查)
- [ ] 卡住回滚:`npx wrangler rollback`
