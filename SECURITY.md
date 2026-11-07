# 安全策略

## 报告漏洞
请勿公开提交 Issue。联系仓库所有者(见 GitHub profile)私下披露。

## 安全设计要点
- 会话:HttpOnly + SameSite=Lax Cookie,JWT HS256(算法混淆防护),30 天 rmb 可续期
- 验证码:HMAC-SHA256 存储(不存明文),单次核销,原子限流(60s 冷却/每小时配额)
- 白名单:每次请求实时校验 invite 状态 —— 停用立即撤销已有会话
- 跨站:中间件在全部路由前(Origin URL 归一化比较 + Fetch Metadata)
- 权限:一切资源仅 owner 可见,越权与不存在统一 404(防枚举)
- 上传:魔数嗅探 + 大小/像素上限,EXIF/GPS 在浏览器端清除(不离开设备)
- 图片下载:仅图像 API 同源(白名单),SSRF 防护
- 密钥:仅存 Cloudflare Secrets;部署状态文件已入 .gitignore

## 已知取舍
- JWT 无服务端吊销表:教师停用通过白名单即时校验兜底(admin 不在白名单,需手动改 users 表)
- D1 Time Travel 仅 7 天,备份请按 docs/BACKUP_AND_RESTORE.md
