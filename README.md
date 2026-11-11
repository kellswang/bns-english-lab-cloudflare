<div align="center">

# 🏫 BNS AI English Lab — Cloudflare Edition

**学校英语教研组 AI 备课工作台**

AI 对话 · 图片创作 · 文档阅读 · 多年级独立部署 · 免费套餐可用

[![CI](https://github.com/kellswang/bns-english-lab-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/kellswang/bns-english-lab-cloudflare/actions)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Vue 3](https://img.shields.io/badge/Vue-3.5-42B883)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020)

</div>

---

## ✨ 功能一览

| 模块 | 说明 |
|---|---|
| 🤖 **AI 对话** | 9 款模型，OpenAI / Anthropic / Google 三家原生协议，4 档思考深度，流式输出，历史分支，编辑重问 |
| 🎨 **图片创作** | 2 款图像模型，15 种画幅(1:1 / A5–A1 横竖 / 4:3 / 3:4 / 16:9 / 9:16)，**原生 2K**(不缩放不裁切)，基于原图编辑，版本树分叉 |
| 📄 **文档阅读** | PDF / DOCX / TXT / CSV / JSON，浏览器端解析(隐私数据不离开设备)，截断如实标注 |
| 🖼️ **附件** | 图片自动去 EXIF/GPS，对话附件缩到模型输入尺寸，参考图保持原分辨率 |
| 🔐 **登录** | 校内邮箱验证码(白名单制)，HMAC 存储，原子限流，点发送即展开验证码区，请求超时兜底，30 天"记住设备" |
| 📊 **管理** | 各教师图片张数 / 费用核对 / 操作日志 / 存储估算 / 免费额度预警 |
| 💰 **费用** | 图片按快照单价，对话按上游账单核对，分账呈现，无隐藏消费 |
| 🏢 **多年级** | 单代码库，每年级独立 Worker / D1 / R2 / Queues / 密钥，互不干扰 |

## 🧩 支持的对话模型

全部走供应商原生协议(不是统一 OpenAI 兼容层)，能力差异按真实请求实测后登记：

| 模型 | 厂商 | 上下文 | 适合场景 |
|---|---|---|---|
| `gpt-6.1-sol` ★默认 | OpenAI | 400K | 推理与写作均衡，备课问答、任务单设计、长文整理 |
| `gpt-6.1-terra` | OpenAI | 400K | 响应快、成本低，日常短问答与批量润色 |
| `gpt-6-astra` | OpenAI | 1M | 长上下文与多模态，一次读入整份单元材料 |
| `claude-sonnet-5-5` | Anthropic | 200K | 英文表达与教学语感，改写语篇、课堂用语、评语 |
| `claude-opus-5-5` | Anthropic | 200K | 强推理与长文组织，课程设计、评分标准、任务拆解 |
| `claude-fable-5-2` | Anthropic | 200K | 叙事与创意表达，故事化语篇、绘本脚本、情境对话 |
| `gemini-3.8-flash` | Google | 1M | 速度最快，课堂即时提问、单词讲解、快速翻译 |
| `gemini-4-argon` | Google | 1M | 多模态强、上下文长，带图分析与整册材料问答 |
| `gemini-4-carbon` | Google | 1M | 新一代多模态长上下文，整册材料问答与带图分析 |

- 四档思考深度按厂商映射：`reasoning.effort` / `thinking.budget_tokens` / `thinkingConfig.thinkingBudget`。
- **上游不可用的型号直接下线**，不留在菜单里当占位；不在白名单的型号一律 400，绝不透传上游，也绝不静默替换成别的型号。

## 🏗️ 架构

```
浏览器 (Vue 3 + Pinia, Cloudflare Static Assets 直出)
  └─ /api/* → Cloudflare Worker (TypeScript + Hono)
       ├─ D1        教师白名单 / 用户 / 项目 / 版本树 / 对话 / 审计
       ├─ R2        原图(私有) / 参考图 / 附件(按所有者鉴权)
       ├─ Queues    图片生成(字节级分阶段流水线，原子领取，幂等)
       ├─ Cron      费用核对(15min) / 任务巡检(5min) / 清理(每日)
       ├─ Resend    验证码邮件(每实例独立密钥)
       └─ AI 网关   图像 + 三家对话(每实例独立密钥)
```

## 🚀 快速体验 Demo

```bash
git clone https://github.com/kellswang/bns-english-lab-cloudflare.git
cd bns-english-lab-cloudflare && npm install
cd apps/web && npm run build && cd ../worker
echo 'DEMO_MODE = "1"' >> .dev.vars
npx wrangler dev
# 打开 http://127.0.0.1:8787 — 演示模式,无需任何 API Key
```

> Demo 模式使用模拟 AI 与固定验证码，不出网不计费。生产环境误配会自动关闭。

## 🛠️ 正式部署（年级负责人）

### 你需要准备

| 项 | 说明 |
|---|---|
| Cloudflare 账户 | Free 套餐即可(R2 需绑卡，免费额度内不扣费) |
| AI API Key | TeamoRouter 或兼容网关(本年级独立计费) |
| Resend API Key | 验证码邮件(已验证发件域名) |
| 教师名单 CSV | 格式：`real_name,email` |
| Node.js 20+ | 本机安装 |

### 三步部署

```bash
# 1. 安装依赖
npm install

# 2. 运行中文安装向导(默认预览，确认后才执行)
node scripts/deploy-grade.mjs

# 3. 按向导输出完成密钥配置 → 构建 → 部署 → 验收
```

详细步骤与截图见 **[docs/DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md)**。

## 💰 免费额度

12 位教师、每天 20 轮对话 + 5~20 张图的规模在 **Cloudflare Free** 内：

| 资源 | 占用 | 免费上限 |
|---|---|---|
| Worker 请求 | ~3% | 100,000/天 |
| D1 读 | 5-10% | 500 万行/天 |
| D1 写 | 15-40% | 10 万行/天 |
| Queues | 2-70%⚠ | 10,000 ops/天 |
| R2 存储 | 55 使用日到 10GB | 10 GB-month |

⚠ Queues 在 20MB 大图档位是第一约束。详见 [docs/COST_MODEL.md](docs/COST_MODEL.md)。

**额外成本(非 Cloudflare)**：AI 网关 $0.02/图 + 对话 token 费；Resend 免费 3,000 封/月。

## 📖 文档

| 文档 | 内容 |
|---|---|
| [部署检查表](docs/DEPLOY_CHECKLIST.md) | 非技术教师 15 分钟部署验收 |
| [部署手册](docs/DEPLOY_GRADE.md) | 完整步骤与命令 |
| [成本模型](docs/COST_MODEL.md) | 免费额度消耗测算与预警 |
| [备份恢复](docs/BACKUP_AND_RESTORE.md) | D1 + R2 备份、恢复演练 |
| [升级回滚](docs/UPGRADE_AND_ROLLBACK.md) | 版本升级与失败回滚 |
| [技术方案](docs/FEASIBILITY.md) | 架构决策与可行性 |

## 🧑‍🏫 教师管理

```bash
node scripts/teachers.mjs list                    # 查看名单
node scripts/teachers.mjs add 张三 t03@school.edu # 增加教师
node scripts/teachers.mjs disable t02@school.edu  # 停用(立即生效)
node scripts/teachers.mjs export                  # 导出名单
```

所有操作默认 dry-run，加 `--apply` 执行。完整命令见 `node scripts/teachers.mjs`。

## 🗒️ 更新记录

### 2026-11-11

- **新增模型**：`claude-fable-5-2`(Claude Fable 5.2)、`gemini-4-carbon`(Gemini 4 Carbon)，
  按原生协议实测 200 并确认返回思考内容后才登记入表；思考档位映射与同厂其它型号一致。
- **下线模型**：移除 `claude-fable-5-5`(曾标注为 Claude Fable 5.1)。该型号自接入起上游一直
  返回 `model_not_available`，菜单里只是个不可选项，没有任何历史对话使用；确认零使用后直接删除，
  白名单收敛为 9 款且全部上游可用。
- **登录体验**：点「发送验证码」**立即**展开验证码区并提示"正在发送…"，发送失败才退回邮箱输入
  (此前要等接口返回才展开，0.4–0.9 秒内界面无变化，用户以为没反应会重复点击，第二次必被限流挡成 429)；
  改动邮箱时明确提示"邮箱已修改，请重新发送"，不再静默收起验证码框；
  统一 API 请求 20 秒超时(上传 180 秒)，网络卡住不再无限停留在"正在验证…"。

## 🤝 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 🔒 安全

发现安全漏洞请勿公开提交，见 [SECURITY.md](SECURITY.md)。

---

<div align="center">

**Built with** Cloudflare Workers · D1 · R2 · Queues · Vue 3 · Hono · TypeScript

</div>
