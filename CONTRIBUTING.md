# 贡献指南

## 开发流程
1. 从 `main` 切出分支:`git checkout -b feat/your-feature`
2. 提交前运行:`npx tsc --noEmit`(apps/worker)、`npm run type-check && npm run build`(apps/web)、
   `npx vitest run`、`npx vitest run --config vitest.deploy.config.ts`、`node scripts/predeploy-check.mjs`
3. 推送分支并发 PR;CI 通过后人工审查合并

## 规则
- 不提交:真实教师名单 / API Key / Session Secret / 部署状态文件 / 备份
- 提交信息用中文或英文均可,一行主题 + 必要时正文说明动机
- 新功能必须带测试;修 bug 必须带能复现的测试
- 涉及付费/生产资源的变更需在 PR 中显著标注

## 项目结构
```
apps/web/        Vue 3 前端(复用原 UI,不重做)
apps/worker/     Cloudflare Worker TS API
scripts/deploy/  一键部署状态机 + Mock Cloudflare(测试)
db/migrations/   D1 迁移
docs/            全部文档
```
