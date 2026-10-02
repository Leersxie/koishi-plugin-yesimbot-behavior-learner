/**
 * 共享工具函数。
 * 全部为纯同步/异步小函数，无任何副作用。
 */

/** 等待指定毫秒数（异步非阻塞） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 内容指纹（防外部修改检测专用）。
 * 注意：只对【文件内容】做 hash，绝不使用 mtime ——
 * 用户打开文件但未保存也会改变 mtime，会造成误报（定死约束）。
 */
export async function hashContent(content: string): Promise<string> {
  // Node 20.19+ 对 Web Crypto 全局可用；为兼容 CJS 环境统一走 node:crypto
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 将 Date 格式化为 YYYYMMDDHHmmss（备份文件名时间戳） */
export function timestampForBackup(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 将 Date 格式化为 HH:mm（证据时间标注） */
export function formatTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 将毫秒时间戳（worldstate.messages.timestamp 为 ms epoch）转为 Date；非法回退当前时间 */
export function tsToDate(ts: number | Date): Date {
  if (ts instanceof Date) return new Date(ts.getTime())
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/** 当天边界（本地时区）：start = 当日 00:00:00.000，end = 次日 00:00:00.000（左闭右开） */
export function todayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

/** 取目标时区的本地时间部件（年月日时分），用于不依赖容器时区的调度/采集 */
export function tzParts(timeZone: string, date: Date = new Date()): { year: number; month: number; day: number; hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // en-US 可能在午夜输出 24
    minute: Number(parts.minute),
  }
}

/** 目标时区相对 UTC 的分钟偏移（北京 = +480）；用同一时刻在目标时区/UTC 的部件差计算，兼容夏令时 */
function tzOffsetMinutes(timeZone: string, date: Date): number {
  const toMinutes = (p: { year: number; month: number; day: number; hour: number; minute: number }): number =>
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60000
  return Math.round(toMinutes(tzParts(timeZone, date)) - toMinutes(tzParts('UTC', date)))
}

/** 按目标时区计算「当天」边界 [start, end)（返回 UTC Date，左闭右开） */
export function todayBoundsInTz(timeZone: string, now: Date = new Date()): { start: Date; end: Date } {
  const { year, month, day } = tzParts(timeZone, now)
  const offsetMin = tzOffsetMinutes(timeZone, now)
  // 「目标时区当天 00:00」的假 UTC 毫秒，减去偏移得到真实 UTC 时刻
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMin * 60000)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end }
}

/** 目标时区 HH:mm 的下一次触发时刻（UTC Date；当天已过则顺延次日，错过不补发） */
export function nextTriggerInTz(timeZone: string, hour: number, minute: number, now: Date = new Date()): Date {
  const { year, month, day } = tzParts(timeZone, now)
  const offsetMin = tzOffsetMinutes(timeZone, now)
  const today = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMin * 60000
  if (today > now.getTime()) return new Date(today)
  return new Date(today + 86400000)
}

/** 字符级编辑距离（Levenshtein）——相似度算法的组成部分 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Jaccard 相似度（字符级别，基于 2-gram 集合） */
export function jaccard(a: string, b: string): number {
  const gram2 = (s: string): string[] => {
    const out: string[] = []
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
    return out.length ? out : [s]
  }
  const setA = new Set(gram2(a))
  const setB = new Set(gram2(b))
  let inter = 0
  for (const g of setA) if (setB.has(g)) inter++
  const union = setA.size + setB.size - inter
  return union ? inter / union : 1
}

/**
 * 条目相似度（0~1）：综合 Jaccard + 编辑距离 + 包含关系。
 * 不引入任何向量依赖（定死约束）：退化时退化为逐字包含 + 长度差。
 */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const ja = jaccard(a, b)
  const maxLen = Math.max(a.length, b.length)
  const edRatio = 1 - levenshtein(a, b) / maxLen
  const contains = a.includes(b) || b.includes(a) ? 1 : 0
  // 加权：包含关系权重最高（"引用原文 → 新条目"场景下逐字包含是强信号）
  return Math.max(ja, edRatio, contains)
}

/** 关键词列表：token 截断时优先保留包含这些词的消息（用户指定） */
export const HIGHLIGHT_KEYWORDS = ['纠正', '别', '不要', '讨厌', '夸']

/** 去除可能包裹的 ```json ``` 代码围栏后再解析 JSON */
export function parseJsonLoose(text: string): any {
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1))
    }
    throw new Error(`无法解析模型输出为 JSON: ${t.slice(0, 120)}`)
  }
}

/** 截断文本，保留指定长度 */
export function truncate(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}
