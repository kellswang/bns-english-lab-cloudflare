# BACKUP_AND_RESTORE — 备份与恢复

## 备份模型(每年级独立)

- **D1 导出**:`wrangler d1 export bns-elab-<grade>-db --remote --output=backup-<日期>.sql`
- **R2 清单 + 对象**:
  ```bash
  npx wrangler r2 object get bns-elab-<grade>-media --prefix=versions/ --output=./r2-backup/   # 分批
  npx wrangler r2 object get bns-elab-<grade>-media --prefix=attachments/ --output=./r2-backup/
  ```
- 生成 `MANIFEST.txt`:逐文件 sha256 + D1 关键行数(projects/versions/chat_messages)。
- 备份包存放:**负责人本机加密盘或学校认可的网盘**,绝不提交到公共仓库。
- **重要**:D1 Time Travel 只有 7 天且不等同完整异地备份;以上手动导出才是正式备份。

## 恢复演练(每学期至少一次,记录在实例清单)

1. 新建**测试用** D1 与 R2(命名带 `-restore-drill` 后缀,演练后删除)。
2. `wrangler d1 execute <测试库> --file=backup-<日期>.sql --remote`
3. 按清单回灌 R2 对象(键路径不变)。
4. 部署一个临时 Worker(绑定测试库),用负责人账号登录并:
   - 打开任一历史项目,下载一张原图(校验 R2 键与 D1 rel_path 一致);
   - 打开任一历史对话(校验消息归属 owner 正确);
   - 管理页汇总数字与备份时 MANIFEST 一致。
5. 演练通过后记录:`RESTORE_DRILL_OK <日期> <演练人>`;失败则修复备份流程并重演。

## 恢复顺序(真实事故时)

1. 停止写入:暂停 Worker(`wrangler deployments list` 确认当前版本;必要时回滚)。
2. 恢复 D1(全量)→ 回灌 R2(缺失对象按 MANIFEST 补齐)。
3. `wrangler deploy` 恢复服务 → 用教师账号抽查 2–3 个项目。
4. 复盘:差异时间段的数据(备份点之后)由教师自行重建;审计日志缺口如实告知。

## 保留建议

- 每周 1 次全量导出;每次升级前必做(见 UPGRADE_AND_ROLLBACK.md)。
- D1 文件 + R2 清单一起存档;R2 大文件可只备原图键(`versions/`),缩略图可再生。
