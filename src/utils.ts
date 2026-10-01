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
