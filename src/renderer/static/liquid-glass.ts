/* eslint-disable no-console */
/**
 * Chatbox · Liquid Glass —— 边缘折射引擎
 *
 * 用 SVG `feDisplacementMap` 实现"边缘折射、中间不变形"的真实液态玻璃观感
 * （苹果 WWDC25 的 Liquid Glass 核心特征）。
 * 参考实现：https://github.com/shuding/liquid-glass （Shu Ding, 2025）
 *
 * 工作方式：
 *  1. 为每个目标元素按其尺寸生成一张"位移贴图"（canvas → dataURL，取 R/G 通道）；
 *  2. 建一个 SVG filter（feImage + feDisplacementMap）；
 *  3. 把 `backdrop-filter: url(#filter) blur() saturate()` 内联到元素上 ——
 *     元素背后的内容在靠近边缘处被微量向内位移，形成透镜般的折射与"膨胀"。
 *
 * 尺寸变化用 ResizeObserver 重建；元素移除自动回收；超量时自动降级。
 * 一键关闭：给 <html> 加 data-lg="off"。
 */

const NS = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

/** 需要折射的目标元素（与 liquid-glass.css 呼应） */
const SELECTOR = [
  '.lg-main-panel',
  '.lg-sidebar',
  '.mantine-Modal-content',
  '.mantine-Drawer-content',
  '.mantine-Menu-dropdown',
  '.mantine-Popover-dropdown',
  '.mantine-Combobox-dropdown',
  '.MuiDialog-paper',
  '.MuiMenu-paper',
  '.MuiPopover-paper',
].join(',')

/** 位移贴图横向最大采样数（越大越细腻、越慢） */
const MAP_MAX_W = 240
/** 同时存在的折射元素上限（兜底性能，超出则不折射、退回普通模糊） */
const MAX_ACTIVE = 18
/** 小于此尺寸的元素不做折射（收益低、数量多） */
const MIN_SIZE = 48

interface Instance {
  id: string
  filter: SVGFilterElement
  feImage: SVGElement
  feDisplace: SVGElement
  canvas: HTMLCanvasElement
  ro: ResizeObserver
  w: number
  h: number
}

const active = new Map<HTMLElement, Instance>()
let svgRoot: SVGSVGElement | null = null
let uid = 0
let rafId = 0
let started = false

function isDisabled() {
  return document.documentElement.getAttribute('data-lg') === 'off'
}

function smoothStep(a: number, b: number, t: number) {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 圆角矩形的有符号距离场 */
function roundedRectSDF(x: number, y: number, halfW: number, halfH: number, radius: number) {
  const qx = Math.abs(x) - halfW + radius
  const qy = Math.abs(y) - halfH + radius
  const mx = Math.max(qx, 0)
  const my = Math.max(qy, 0)
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(mx * mx + my * my) - radius
}

function getSvgRoot(): SVGSVGElement {
  if (svgRoot && svgRoot.isConnected) return svgRoot
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;'
  svg.appendChild(document.createElementNS(NS, 'defs'))
  document.body.appendChild(svg)
  svgRoot = svg
  return svg
}

/**
 * 生成位移贴图：靠近边缘的像素向中心方向位移，中心不动。
 * 返回 canvas 与位移峰值（px）。
 */
function buildDisplacementMap(el: HTMLElement, w: number, h: number) {
  const cs = getComputedStyle(el)
  const radiusRaw = parseFloat(cs.borderTopLeftRadius) || 0
  const radius = Math.max(0, Math.min(radiusRaw, Math.min(w, h) / 2))
  // 折射影响带宽度：越小的元素带越窄
  const band = Math.max(10, Math.min(30, Math.min(w, h) * 0.09))
  // 峰值位移随尺寸轻微缩放，避免大面板边缘"糊"
  const peak = Math.max(4, Math.min(12, Math.min(w, h) * 0.05))

  const k = Math.min(1, MAP_MAX_W / w)
  const cw = Math.max(2, Math.round(w * k))
  const ch = Math.max(2, Math.round(h * k))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const imageData = ctx.createImageData(cw, ch)
  const data = imageData.data

  const halfW = w / 2
  const halfH = h / 2
  const raw = new Float32Array(cw * ch * 2)
  let maxMag = 0

  for (let y = 0; y < ch; y++) {
    const py = ((y + 0.5) / ch) * h - halfH
    for (let x = 0; x < cw; x++) {
      const px = ((x + 0.5) / cw) * w - halfW
      const dist = roundedRectSDF(px, py, halfW - radius, halfH - radius, radius)
      // 内部深处 dist 很负 → 位移 0；靠近边界 → 位移峰值
      const strength = 1 - smoothStep(0, band, -dist)
      const len = Math.sqrt(px * px + py * py) || 1
      const mag = strength * peak
      const dx = (-px / len) * mag
      const dy = (-py / len) * mag
      const idx = (y * cw + x) * 2
      raw[idx] = dx
      raw[idx + 1] = dy
      if (Math.abs(dx) > maxMag) maxMag = Math.abs(dx)
      if (Math.abs(dy) > maxMag) maxMag = Math.abs(dy)
    }
  }

  maxMag = Math.max(maxMag, 0.001)
  for (let i = 0, k2 = 0; i < data.length; i += 4) {
    data[i] = (raw[k2++] / maxMag + 0.5) * 255
    data[i + 1] = (raw[k2++] / maxMag + 0.5) * 255
    data[i + 2] = 0
    data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)

  return { canvas, scale: maxMag }
}

function applyBackdropFilter(el: HTMLElement, id: string) {
  const cs = getComputedStyle(el)
  const blur = (cs.getPropertyValue('--lg-blur') || '24px').trim() || '24px'
  const saturate = (cs.getPropertyValue('--lg-saturate') || '1.6').trim() || '1.6'
  const value = `url(#${id}) blur(${blur}) saturate(${saturate})`
  el.style.setProperty('backdrop-filter', value)
  el.style.setProperty('-webkit-backdrop-filter', value)
}

function mount(el: HTMLElement) {
  const w = el.clientWidth
  const h = el.clientHeight
  if (w < MIN_SIZE || h < MIN_SIZE) return
  if (active.size >= MAX_ACTIVE) return

  const built = buildDisplacementMap(el, w, h)
  if (!built) return

  const id = `lg-refract-${++uid}`
  const svg = getSvgRoot()
  const defs = svg.querySelector('defs')
  if (!defs) return

  const filter = document.createElementNS(NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  filter.setAttribute('colorInterpolationFilters', 'sRGB')
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', String(w))
  filter.setAttribute('height', String(h))

  const feImage = document.createElementNS(NS, 'feImage')
  feImage.setAttribute('id', `${id}-map`)
  feImage.setAttribute('preserveAspectRatio', 'none')
  feImage.setAttribute('width', String(w))
  feImage.setAttribute('height', String(h))
  feImage.setAttributeNS(XLINK, 'xlink:href', built.canvas.toDataURL())
  feImage.setAttribute('href', built.canvas.toDataURL())

  const feDisplace = document.createElementNS(NS, 'feDisplacementMap')
  feDisplace.setAttribute('in', 'SourceGraphic')
  feDisplace.setAttribute('in2', `${id}-map`)
  feDisplace.setAttribute('xChannelSelector', 'R')
  feDisplace.setAttribute('yChannelSelector', 'G')
  feDisplace.setAttribute('scale', String(built.scale))

  filter.appendChild(feImage)
  filter.appendChild(feDisplace)
  defs.appendChild(filter)

  applyBackdropFilter(el, id)

  const ro = new ResizeObserver(() => {
    refresh(el)
  })
  ro.observe(el)

  active.set(el, {
    id,
    filter,
    feImage,
    feDisplace,
    canvas: built.canvas,
    ro,
    w,
    h,
  })
}

function refresh(el: HTMLElement) {
  const inst = active.get(el)
  if (!inst) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (w < MIN_SIZE || h < MIN_SIZE) return
  if (Math.abs(w - inst.w) < 2 && Math.abs(h - inst.h) < 2) return

  const built = buildDisplacementMap(el, w, h)
  if (!built) return

  const href = built.canvas.toDataURL()
  inst.feImage.setAttributeNS(XLINK, 'xlink:href', href)
  inst.feImage.setAttribute('href', href)
  inst.feImage.setAttribute('width', String(w))
  inst.feImage.setAttribute('height', String(h))
  inst.feDisplace.setAttribute('scale', String(built.scale))
  inst.filter.setAttribute('width', String(w))
  inst.filter.setAttribute('height', String(h))
  inst.w = w
  inst.h = h
}

function unmount(el: HTMLElement, inst: Instance) {
  inst.ro.disconnect()
  inst.filter.remove()
  active.delete(el)
}

function scan() {
  if (isDisabled()) {
    for (const [el, inst] of active) unmount(el, inst)
    return
  }
  const nodes = document.querySelectorAll(SELECTOR)
  nodes.forEach((node) => {
    const el = node as HTMLElement
    if (!active.has(el)) mount(el)
  })
  // 回收已从文档移除的元素
  for (const [el, inst] of active) {
    if (!el.isConnected) unmount(el, inst)
  }
}

function schedule() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    scan()
  })
}

/** 启动：扫描现有元素，并持续监听新增元素 */
export function initLiquidGlass() {
  if (started) return
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return
  started = true

  schedule()

  const observer = new MutationObserver(() => schedule())
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('resize', schedule)
}
