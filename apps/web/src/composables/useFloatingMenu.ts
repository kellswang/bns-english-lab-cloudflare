import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * 让下拉菜单脱离父级滚动容器的裁剪。
 *
 * 输入框里的模型 / 画幅菜单用 position: absolute 向上展开时，会被
 * .chat-body{overflow-y:auto} 这类祖先元素切掉顶部（首页输入框居中的时候尤其明显，
 * 第一项只能看到下半边）。这里改成 Teleport 到 body + position: fixed，
 * 打开时按触发按钮的实际位置算出坐标，向上放不下就自动往下放，
 * 并把手柄高度限制在可视区域内，滚动 / 缩放窗口时同步跟随。
 */
export interface FloatingMenuOptions {
  /** 菜单与触发按钮之间的间距 */
  gap?: number
  /** 菜单最小宽度（触发按钮更宽时取按钮宽度） */
  minWidth?: number
  /** 菜单最多能有多高，实际还会受可视空间限制 */
  maxHeight?: number
  /** 水平对齐方式：left 与按钮左对齐，right 与按钮右对齐 */
  align?: 'left' | 'right'
  /** 点击外部 / 按 Esc 时的收起回调 */
  onDismiss?: () => void
}

const EDGE = 10

export function useFloatingMenu(
  anchor: Ref<HTMLElement | null>,
  menu: Ref<HTMLElement | null>,
  open: Ref<boolean>,
  options: FloatingMenuOptions = {},
) {
  const gap = options.gap ?? 8
  const style = ref<Record<string, string>>({})
  const side = ref<'up' | 'down'>('up')

  function place() {
    const a = anchor.value
    if (!a) return
    const r = a.getBoundingClientRect()
    // 向上展开时以整个输入框卡片的上沿为基准，避免菜单压住正在输入的文字
    const panel = a.closest('.chat-composer, .img-composer') as HTMLElement | null
    const top = panel ? Math.min(r.top, panel.getBoundingClientRect().top) : r.top
    const vw = window.innerWidth
    const vh = window.innerHeight
    const wanted = options.maxHeight ?? 420
    const width = Math.min(Math.max(options.minWidth ?? 0, r.width), vw - EDGE * 2)

    let left = options.align === 'right' ? r.right - width : r.left
    if (left + width > vw - EDGE) left = vw - EDGE - width
    if (left < EDGE) left = EDGE

    const above = top - gap - EDGE
    const below = vh - r.bottom - gap - EDGE
    // 上下都放不下时，优先放空间更大的一侧
    const up = above >= Math.min(wanted, below)
    side.value = up ? 'up' : 'down'
    const maxHeight = Math.max(140, Math.min(wanted, up ? above : below))

    style.value = up
      ? {
          position: 'fixed', left: `${Math.round(left)}px`, width: `${Math.round(width)}px`,
          maxHeight: `${Math.round(maxHeight)}px`,
          bottom: `${Math.round(vh - top + gap)}px`, top: 'auto',
        }
      : {
          position: 'fixed', left: `${Math.round(left)}px`, width: `${Math.round(width)}px`,
          maxHeight: `${Math.round(maxHeight)}px`,
          top: `${Math.round(r.bottom + gap)}px`, bottom: 'auto',
        }
  }

  let raf = 0
  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; place() })
  }

  function onPointerDown(e: Event) {
    const t = e.target as Node | null
    if (!t) return
    if (anchor.value?.contains(t) || menu.value?.contains(t)) return
    options.onDismiss?.()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') options.onDismiss?.()
  }

  function bind() {
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeydown)
    void nextTick(place)
  }

  function unbind() {
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeydown)
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
  }

  watch(open, (v) => (v ? bind() : unbind()), { immediate: true })
  onBeforeUnmount(unbind)

  return { style, side, place }
}
