# TEST_REPORT — 第二轮(P2 后)

执行日期:2026-11-07 · 环境:Windows + Node 24 + wrangler getPlatformProxy + 本地 mock 上游(真实 HTTP)

## 1. 命令与结果

| 命令 | 结果 |
|---|---|
| `tsc --noEmit`(worker) | ✅ 0 错误 |
| `vitest run` | ✅ **12 文件 / 85 测试全通过** |
| `vue-tsc --noEmit`(web) | ✅ 0 错误 |
| `vite build`(web) | ✅ pdf.js/mammoth 懒加载分块正确 |
| `tsx spikes/gateA-bigpayload.mts` | ✅ 2/5/10/20MB 流水线全过(5/9/15/29 次队列调用,字节精确一致) |
| `wrangler dev` + 真浏览器 E2E | ✅ 全流程(见 §3) |
| `scripts/predeploy-check.mjs` | ✅ 无泄漏 |

## 2. 新增测试(本轮)

| 测试项 | 类型 | 结果 | 证据 |
|---|---|---|---|
| 分块 base64 解码(与 atob 交叉验证、4 字节对齐切片、padding、非法字符) | 单元 | ✅ | test/unit/b64chunk.test.ts |
| b64-inline 小图路径(单次解码、元数据、尺寸) | 集成 | ✅ | imageDelivery.test |
| b64-staged 分块路径(分窗扫描→分片解码→合成,字节一致,暂存清理) | 集成 | ✅ | imageDelivery.test |
| URL 模式(有/无 content-length、同源白名单拒绝、不发起下载) | 集成 | ✅ | imageDelivery.test |
| 上游只调一次 + 重复投递幂等(真实 HTTP mock 计数) | 集成 | ✅ | generation.test |
| 12/20/30 并发教师(登录+生图全成功;9.2s/13.0s/20.9s) | 压测(本地) | ✅ | stress.test |
| 缩略图上传端点(JPEG 魔数/归属/大小校验) | 集成 | ✅ | files.ts 语义 + E2E 回退 |

## 3. 浏览器 E2E(wrangler dev + 本地 mock 上游 + 真浏览器)

| 步骤 | 结果 | 关键证据 |
|---|---|---|
| 登录页渲染(视频/域名后缀 @example.edu 由配置下发) | ✅ | DOM 快照 |
| 白名单教师验证码登录(dev_code) | ✅ | 顶栏显示"E2E教师"+ $0.00 |
| AI 对话流式(mock SSE) | ✅ | 「这是E2E mock 回答。」+ 4 tokens |
| 重新生成 → 新分支 | ✅ | 分支 3/3 |
| 对话标题自动命名 + 历史侧栏 | ✅ | 「今天」分组 |
| 图片生成(mock b64,流水线) | ✅ | 「已生成」+ V1 版本轨 |
| 累计消费快照估价 | ✅ | $0.02(图片)+ 1 条待核对 |
| 项目隐式创建 + 自动命名 | ✅ | 侧栏出现同名项目 |
| 版本时间戳北京时间 | ✅ | 2026-11-07 14:30 |
| 原图下载(PNG 魔数 + Content-Disposition) | ✅ | 150,000 字节,dlStatus 200 |
| 缩略图(未生成时回退原图) | ✅ | thumbStatus 200 |
| 退出登录 → 回登录页 | ✅ | url=/login |
| 未受 IAB 限制项:文件上传选择器 | 未走完 | 附件抽取逻辑由官方库+服务端测试覆盖 |

## 4. 原项目完整性

- 复核比对 131 文件清单:**IDENTICAL,原项目零修改**(快照 `_audit/original-manifest-*.txt`)。

## 5. 仍未验证 / 未完成(如实)

1. **Cloudflare Free 线上全部验证** —— 阻塞于账户授权;工具已备好
   (`spikes/live-cpu-probe/` + README-LIVE.md,含三通道 CPU 采集与判定表)。
2. Resend 真实发信;真实 AI 上游的三协议/编辑链路(线上配置后立即可测)。
3. GitHub 远程推送(网络不通 + API 409"empty repo" 限制;本地 git 完好)。
4. iPhone Safari 真机体验、390px 布局人工验收(需真机)。
