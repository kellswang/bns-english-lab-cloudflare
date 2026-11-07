# BNS AI English Lab — Cloudflare Edition

面向学校英语教研组的 AI 备课工作台:AI 对话(三家原生协议)+ 图片创作(15 画幅原生 2K)+ 文档阅读(PDF/DOCX)。
单代码库,**每个年级一份独立部署**(Worker / D1 / R2 / Queues / 教师白名单 / 密钥全部隔离)。

## 功能

- **AI 对话**:OpenAI Responses / Anthropic Messages / Google Gemini 原生协议,4 档思考深度,流式输出,历史分支,PDF/DOCX/图片附件
- **图片创作**:2 款图像模型,15 种画幅(1:1 / A5–A1 横竖 / 4:3 / 3:4 / 16:9 / 9:16),原生 2K(不缩放),基于原图编辑,版本树分叉
- **登录**:校内邮箱验证码(白名单制,HMAC 存储,原子限流),30 天"记住设备"
- **管理**:只读汇总(各教师图片张数/费用核对状态)、操作日志、存储估算与预警
- **费用**:图片按快照单价估算,对话按上游实际账单 Cron 核对,分账呈现

## 架构

```
浏览器 (Vue 3 + Pinia, Static Assets 直出)
  └─ /api/* → Cloudflare Worker (TypeScript, Hono)
       ├─ D1        教师白名单 / 用户 / 项目 / 版本树 / 对话 / 审计
       ├─ R2        原图(私有) / 参考图 / 附件(按所有者鉴权)
       ├─ Queues    图片生成任务(字节级分阶段流水线,原子领取,幂等)
       ├─ Cron      费用核对(15min) / 任务巡检(5min) / 清理(每日)
       ├─ Resend    验证码邮件(每实例独立密钥)
       └─ AI 网关   TeamoRouter 图像 + 三家对话(每实例独立密钥)
```

## Cloudflare Free 适用条件

12 位教师、每天约 20 轮对话 + 5~20 张图的规模在免费额度内(请求 <5%、D1 读 <10%)。
限制与预警详见 `docs/COST_MODEL.md`;**Queues 在 20MB 大图档位是第一约束**(29 ops/张),
日常建议小档位。图片走"字节级分阶段流水线",单次调用 CPU ≪ 10ms(线上数值待探针实测)。

## 额外成本(非 Cloudflare)

- AI 网关:图片 $0.02/张(站内快照价)+ 对话 token 费 —— 由各年级自己的密钥承担
- Resend 邮件:免费档每月 3,000 封,验证码用量内通常免费

## 快速体验 Demo

```
cd apps/web && npm install && npm run build
cd ../worker
cp .dev.vars.example .dev.vars   # 编辑:DEMO_MODE = "1"(演示模式)
npx wrangler dev                 # 打开 http://127.0.0.1:8787
```

Demo 模式使用固定演示账号与模拟 AI(不出网、不计费),与生产模式严格隔离
(生产环境误配 DEMO_MODE 会被启动安全阀强制关闭)。

## 从零开始部署(年级负责人)

1. 安装 Node.js 20+
2. `npm install`
3. `node scripts/deploy-grade.mjs` → 中文向导(默认预览,确认后才执行)
4. 完成后按 `docs/DEPLOY_CHECKLIST.md` 验收

详见 `docs/DEPLOY_GRADE.md`。需要准备:TeamoRouter API Key、教师名单 CSV、
Cloudflare API Token(受限)、Resend API Key。

## 常见问题

| 现象 | 处理 |
|---|---|
| 验证码收不到 | 检查 Resend 域名验证与发件地址;名单外邮箱不发信 |
| R2 报 "not entitled" | 控制台开通 R2(免费,需绑卡) |
| 部署中途失败 | 直接重跑 `node scripts/deploy-grade.mjs --resume`,已完成阶段自动跳过 |
| 生成卡住 | 任务会被巡检自动重驱动;绝不重复扣费 |
| 图片很大 / 队列慢 | 参考文档 COST_MODEL 的档位建议 |

## 升级 / 备份 / 恢复

- 升级:`docs/UPGRADE_AND_ROLLBACK.md`(先备份 → git pull → 迁移 → 部署 → 健康检查;失败 `wrangler rollback`)
- 备份:`node scripts/backup-d1.mjs <年级>` + `node scripts/backup-r2.mjs <年级> --hash`
- 恢复演练:`npx tsx scripts/restore-drill.mts`(本地模拟,RESTORE_DRILL_OK)

## 贡献

见 `CONTRIBUTING.md`。安全漏洞请勿公开提交,见 `SECURITY.md`。

## 状态

| 项 | 状态 |
|---|---|
| 本地自动化测试 | ✅ 119 + 23 项通过 |
| 真浏览器 E2E | ✅ 全链路(见 docs/TEST_REPORT.md) |
| Cloudflare Free 线上验证 | ⏳ 待真实账户(探针与手册已备好) |

English README: 见 `docs/README_EN.md`(占位,欢迎贡献翻译)。
