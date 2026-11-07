# DEPLOY_GRADE — 年级负责人部署手册(每年级一份独立实例)

> 适用对象:非开发者年级负责人。全程只在自己的 Cloudflare 账户操作。
> 真实耗时未验证(标注:待验证);预计 30–60 分钟 + 邮件域名验证等待。

## 0. 前置条件(需提前准备)

- [ ] 一个 Cloudflare 账户(Free 套餐即可;R2 需要绑定一张付款卡,**Free 额度内不扣费**)
- [ ] 一个 Resend 账户 + 完成发件域名验证(如 `mail.<年级域名>`);**这不是 Cloudflare 的开销,
      是邮件平台的前置要求**,没有它无法发登录验证码
- [ ] 图像 API 与对话 API 的网关地址 + 密钥(本年级独立计费)
- [ ] 本年级教师名单 CSV(用 `config/teachers.template.csv` 填真实名单,**不要提交进仓库**)

## 1. 安装工具

```bash
node -v        # 需要 Node 20+
npm install    # 在 bns-english-lab-cloudflare 目录
```

## 2. 创建资源(全部命令在 `apps/worker/` 下执行)

```bash
npx wrangler login                                  # 登录你自己的账户
npx wrangler d1 create bns-elab-<grade>-db          # 记下 database_id
npx wrangler r2 bucket create bns-elab-<grade>-media
npx wrangler queues create bns-elab-<grade>-imggen
npx wrangler queues create bns-elab-<grade>-imggen-dlq
```

复制 `wrangler.jsonc.example` 为 `wrangler.jsonc`(已在 .gitignore),填入:
`name`、`database_id`、队列名、vars(年级名/邮箱域名/ADMIN_EMAILS 等)。

## 3. 配置密钥(每实例独立,绝不复用其他年级)

```bash
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32 生成
npx wrangler secret put OTP_SECRET       # 单独生成
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put AI_API_KEY
npx wrangler secret put CHAT_API_KEY
```

## 4. 初始化数据库与白名单

```bash
npx wrangler d1 migrations apply bns-elab-<grade>-db --remote
node ../../scripts/import-teachers.mjs teachers.csv   # 幂等:新增/改名/停用,不覆盖手工更正
```

## 5. 构建并部署

```bash
cd ../web && npm run build && cd ../worker
npx wrangler deploy
```

部署后浏览器打开 `https://bns-elab-<grade>.<账户子域>.workers.dev`,
用名单内邮箱走一遍登录 → 新建对话 → 新建创作 → 上传参考图 → 下载图片 → 管理页(仅负责人)。

## 6. 部署后检查(每项通过才算完成)

- [ ] `/api/v1/health` 返回 `{"ok":true}`
- [ ] 名单外邮箱请求验证码 → 提示未获得使用权限,且邮箱收不到信
- [ ] 验证码登录成功,右上角显示教师姓名(来自 CSV real_name)
- [ ] 试生图 1 张(小尺寸)→ 出图、可下载、版本轨出现 V1
- [ ] 试对话 1 轮(默认模型)→ 流式输出、停止按钮有效
- [ ] Cloudflare Dashboard → Workers & Pages → 该 Worker → Metrics:无异常 5xx
- [ ] Resend 控制台:验证码邮件送达记录

## 7. 每年级实例清单(完成后归档)

| 项 | 值(负责人填写,勿共享) |
|---|---|
| Worker 名 | |
| D1 database_id | |
| R2 bucket | |
| Queue / DLQ | |
| workers.dev 域名 | |
| 管理员邮箱 | |
