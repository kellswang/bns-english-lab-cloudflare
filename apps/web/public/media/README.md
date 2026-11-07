# 登录页视觉素材

左侧逐帧动画（教研组提供，2026-11-05 更换为品牌植物字母版）。

| 文件 | 用途 | 规格 |
| --- | --- | --- |
| `login-animation.mp4` | 主视频 | 480×480，H.264，10 秒，847 KB，无音轨 |
| `login-animation.webm` | 同片 VP9 版本，浏览器优先选用 | 480×480，451 KB |
| `login-poster.jpg` | 视频首帧，加载占位 / 播放失败回退 | 480×480，JPEG，26 KB |
| `login-poster.svg` | 终极兜底封面（首帧也缺失时） | 1000×1000，配色与首帧一致 |

首帧主色为暖米白 `#efe7d0`（植物拼贴字母 B 的纸底）。登录页左侧媒体区背景已对齐这个颜色，
因此视频加载前后、以及降级到封面时都不会跳色。

## 页面行为

- `src/components/LoginVisual.vue` 先铺一层首帧封面，视频 `playing` 后才淡入。
- `autoplay muted loop playsinline`，无控制条，`object-fit: contain`，
  保持 1:1 原始比例、完整呈现不裁切不拉伸，四周由同色底补足。
- 同时提供 WebM 与 MP4 两个 `<source>`，浏览器自行选择；全部失败时保持封面。
- `prefers-reduced-motion: reduce` 时不渲染 `<video>`，完全不请求视频资源。
- 封面 JPG 再失败时回退到同色系 SVG，不出现破图图标。
- 登录表单在右侧，视觉资源失败不影响任何登录操作。

## 替换方式

1. 用新视频覆盖 `login-animation.mp4`；若需要 WebM，用 ffmpeg 重新转一份：
   ```bash
   ffmpeg -i login-animation.mp4 -c:v libvpx-vp9 -crf 36 -b:v 0 -an login-animation.webm
   ```
2. 重新提取首帧，保证加载瞬间不跳色：
   ```bash
   ffmpeg -i login-animation.mp4 -frames:v 1 -q:v 3 login-poster.jpg
   ```
3. 若新片主色变了，同步修改 `src/styles/main.css` 里 `.gate-visual` 的 `background`
   与 `.gate-visual-tag` 的文字颜色，以及 `login-poster.svg` 的配色。
4. 重新构建前端，无需改动代码：
   ```bash
   cd frontend && npm run build
   ```
