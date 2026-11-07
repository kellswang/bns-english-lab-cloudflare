# bns-english-lab-cloudflare

BNS 英语教研平台的 **Cloudflare 原生**重构版:单代码库、每年级一份独立部署
(one codebase, isolated single-tenant deployments)。

与原项目(`english-workbench`,FastAPI + SQLite + 线程池,香港服务器)的关系:

| | 原项目 | 本项目 |
|---|---|---|
| 运行时 | Linux VPS + Python 3.10 + systemd | Cloudflare Workers (TypeScript) |
| 数据库 | SQLite 文件 | Cloudflare D1 |
| 文件存储 | 本地磁盘 data/ | Cloudflare R2(私有) |
| 图片任务 | 进程内 ThreadPoolExecutor | Cloudflare Queues + 原子领取 |
| 费用核对 | 常驻 asyncio billing_loop | Cron Trigger 小批量核对 |
| 邮件 | Resend(同一套) | Resend(每实例独立密钥) |
| 前端 | Vue 3 + Vite + Pinia | 同一套前端(Static Assets 托管) |

**本仓库不包含任何真实教师名单、邮箱、密钥或生产配置。**
每个年级负责人使用自己的 Cloudflare 账户,按 `docs/DEPLOY_GRADE.md` 独立部署。

## 年级负责人自助部署（测试版）

**首次开通仍需人工完成 Cloudflare/R2 订阅和 Resend 发件域名验证。** 日常资源创建、D1 迁移、密钥注入、名单导入及 Worker 发布已提供分步骤脚本和受保护的初版自动部署入口。

- [自助部署指南（含配置、预览与执行）](docs/SELF_SERVICE_DEPLOYMENT.md)
- [公开仓库前安全与版权检查清单](docs/PUBLIC_RELEASE_CHECKLIST.md)
- [原有分步骤部署手册](docs/DEPLOY_GRADE.md)
- 首次部署（预览）：`node scripts/deploy-grade.mjs --teachers <私有教师名单.csv>`
- 首次部署（明确执行）：`node scripts/deploy-grade.mjs --teachers <私有教师名单.csv> --apply`

**注意：** 初版脚本尚未在全新 Cloudflare 账户实测；`main` 暂不修改，代码库也暂不公开。真实教师名单、Cloudflare Token、TeamoRouter/Resend Key 不能提交至 GitHub。

## 目录

```
apps/web/        Vue 3 前端(复用原项目 UI)
apps/worker/     Cloudflare Worker TypeScript API(/api/v1)
db/migrations/   D1 编号迁移 SQL
scripts/         初始化 / 白名单导入 / 备份恢复 / 部署前检查
config/          安全模板(占位符,不含真实人员)
docs/            架构 / 审计 / 可行性 / 兼容性 / 部署 / 备份 / 成本 / 测试报告
spikes/          Cloudflare Free 可行性验证代码与结论
```

## 状态

第三轮本地生产加固已在 dev/round3-hardening 分支完成；自助部署仍待云端验收,结论见 `docs/FEASIBILITY.md`。
尚未获得 Cloudflare 账户授权,所有线上标注为「未验证」;本地可运行部分标注「本地通过」。
