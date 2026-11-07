# UPGRADE_AND_ROLLBACK — 升级与回滚

## 统一版本流

主仓库(各年级共同上游)发布版本 → 各年级负责人各自执行:

```bash
git pull origin v<版本>        # 或下载发布包并校验 sha256
npm install
npm run build:web              # 前端构建
cd apps/worker
npx wrangler d1 migrations apply bns-elab-<grade>-db --remote   # 若有新迁移
npx wrangler deploy
```

## 升级前必做

1. **备份**:按 BACKUP_AND_RESTORE.md 导出 D1 + R2 清单。
2. `npx wrangler deployments list` 记下当前版本(回滚点)。
3. 阅读 CHANGELOG:标有 **不可逆** 的 D1 迁移必须先确认备份可恢复,再 apply。

## 回滚

- **代码/前端**:`npx wrangler rollback`(回到上一部署版本)——静态资产与 Worker 一体回退。
- **D1 迁移**:加法迁移(schema_migrations 递增)通常无需回滚;若必须回滚,
  用升级前备份恢复到**新建测试库**验证后,再经维护窗口恢复生产库。
  **代码回滚 ≠ 数据库回滚**,两者不要在同一步骤混合操作。

## 失败判据(部署后 10 分钟内任一出现即回滚)

- `/api/v1/health` 返回 503 或非 200;
- 教师登录报 500;试生图任务卡 queued 超过 5 分钟;
- Dashboard Metrics 出现异常错误率。

## 多实例推进

- 先在自己的"演练实例"(独立 D1/R2)升级验证一轮,再动生产实例。
- 各年级独立升级,不要求同步;升级记录写回各实例清单。
