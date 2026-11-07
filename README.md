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

Phase 0(源码审计 + 免费额度可行性闸门)进行中,结论见 `docs/FEASIBILITY.md`。
尚未获得 Cloudflare 账户授权,所有线上标注为「未验证」;本地可运行部分标注「本地通过」。
