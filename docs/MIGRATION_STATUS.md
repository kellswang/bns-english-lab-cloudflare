# MIGRATION_STATUS — 功能迁移状态矩阵(P2 完成后)

标注:**已实现+测试通过**(本地自动化)/ **E2E 通过**(真浏览器 wrangler dev)/
**线上验证通过**(需授权,当前无)/ **受限**(见说明)。

## 认证与权限
| 功能 | 状态 | 证据 |
|---|---|---|
| 白名单验证码登录(6位/5分钟/单次/5次尝试/60s冷却) | 已实现+测试通过+E2E 通过 | auth.test 8 项;E2E 登录流程 |
| 名单外 403 不发信不留记录 | 已实现+测试通过 | auth.test |
| 停用立即失效 / 管理员提权 | 已实现+测试通过 | auth.test |
| 会话 JWT(rmb 30天/1天/续期) | 已实现+测试通过 | tokens.test |
| Resend 真实发信 | **未验证**(需各实例密钥+域名验证) | dev 环境 mock 发码 |

## AI 对话
| 功能 | 状态 | 证据 |
|---|---|---|
| 三家原生协议(OpenAI/Anthropic/Gemini) | 已实现+测试通过(fixture) | providers.test 7 项;真实上游未测 |
| 4 档思考映射 | 已实现+测试通过 | capabilities 单元语义 |
| SSE 流式(start/delta/meta/finish/[DONE]) | 已实现+测试通过+E2E 通过 | chat.test 5 项;E2E「这是E2E mock 回答。」 |
| 幂等重放(双击不重复付费) | 已实现+测试通过 | chat.test |
| 编辑重问/分支切换/重新生成 | 已实现+测试通过+E2E 通过 | chat.test;E2E 分支 3/3 |
| 历史压缩摘要+SummaryCall 对账 | 已实现+测试通过 | chatBudget.test |
| 跨实例 stop(D1 信号) | 已实现+测试通过 | chat.test stop 用例 |
| **PDF/DOCX 浏览器端正文抽取** | 已实现+E2E 环境待验(见注) | attachParse.ts;pdf.js/mammoth 懒加载 |
| 不可用模型不静默替换 | 已实现+测试通过 | chat.test |

> 注:附件正文抽取的代码已实现并随前端构建,但 E2E 的文件上传环节受浏览器自动化
> 文件选择器限制未走完;抽取逻辑的正确性由 pdf.js/mammoth 官方库保证 + 服务端限长测试覆盖。

## 图片生成
| 功能 | 状态 | 证据 |
|---|---|---|
| 15 画幅原生 2K(不缩水) | 已实现+测试通过 | sizes.test 19 项 |
| 双模型白名单(编辑/参考图) | 已实现+测试通过 | generation.test |
| **大图分阶段流水线**(capture→scan→decode→assemble) | 已实现+测试通过+spike 全过 | spike 2/5/10/20MB 字节一致 |
| URL 模式(同源白名单,无 base64) | 已实现+测试通过 | imageDelivery 3 项 |
| 幂等(同键去重/同键异参 409/每日限额) | 已实现+测试通过 | generation.test |
| 队列重复投递不重复付费;5xx→uncertain | 已实现+测试通过 | generation.test |
| 版本树(parent/source/MAIN+B 分支) | 已实现+测试通过+E2E 通过 | E2E V1 版本轨 |
| pending_save / interrupted 收敛 | 已实现+测试通过 | sweep.test 语义 |
| 12/20/30 并发 | 已实现+测试通过(本地模拟) | stress.test:9.2s/13.0s/20.9s 全成功 |
| 缩略图(浏览器生成上传) | 已实现+测试通过(端点);E2E 回退原图验证 | files.ts PUT thumb;E2E thumb 200 |
| 自适应轮询(3s→15s 退避+隐藏暂停) | 已实现 | workspace.ts;E2E 出图验证 |

## 文件与用量
| 功能 | 状态 |
|---|---|
| 归属校验下载(PNG 魔数/Content-Disposition) | 已实现+测试通过+E2E 通过(150000 字节 PNG) |
| R2 对象缺失 410 | 已实现 |
| 用量口径(快照价+verified+pending) | 已实现+测试通过 |
| 管理页汇总/日志(北京时间) | 已实现+测试通过 |
| 站内存储估算+阈值(admin/storage) | 已实现 |
| 站内日用量(admin/usage-daily) | 已实现 |

## 部署与运维
| 项 | 状态 |
|---|---|
| 年级独立配置模板(无真实人员) | 已实现;predeploy-check 通过 |
| new-grade.mjs 资源引导 / import-teachers / backup-d1 / usage-report | 已实现(命令行未在真实账户执行=未验证) |
| DEPLOY_GRADE / DEPLOY_CHECKLIST / BACKUP / UPGRADE 文档 | 已实现 |
| **Cloudflare Free 线上验证(全部)** | **未验证** — 等 live-cpu-probe 授权 |
| GitHub 远程仓库 | **受阻**(github.com 网络不通,API 建 repo 后 Git Data API 撞"empty repo"409;本地 git 仓库完好,可推送时机待定) |
