import type { Context, Logger } from 'koishi'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { statsFilePath } from '../paths'
import type { PendingCandidate } from './pending-store'

/**
 * 行为候选统计（behavior.stats.json）读写。
 *
 * 记录每次采纳/跳过/全跳过/查重命中的动作与候选质量指标，供「行为 统计」指令展示，
 * 用于评估提炼 prompt 的效果（采纳率、跳过率、平均置信度、分类分布）。
 *
 * 文件位于 memory/ 根目录（不在 core），与 pending 同目录，不会被 yesimbot 扫描注入。
 */

/** 单个统计动作（追加式历史，保留最近 maxHistoryLength 条） */
export interface StatsEntry {
  /** 动作：adopt=采纳 / skip=跳过 / clear=全跳过 / duplicate=查重命中 */
  action: 'adopt' | 'skip' | 'clear' | 'duplicate'
  /** 候选 ID（clear 时为 '-'） */
  candidateId: string
  /** 分类（clear 时为 '-'） */
  category: string
  /** 置信度 0~1 */
  confidence: number
  /** 动作发生时间（ms epoch） */
  timestamp: number
}

/** 统计文件结构 */
export interface StatsFile {
  /** 累计提炼轮次 */
  totalRounds: number
  /** 累计候选条数 */
  totalCandidates: number
  /** 采纳数 / 跳过数 / 查重命中数 */
  adopted: number
  skipped: number
  duplicated: number
  /** 分类分布：category → { adopted, skipped, total } */
  byCategory: Record<string, { adopted: number; skipped: number; total: number }>
  /** 历史动作（最近 maxHistoryLength 条） */
  history: StatsEntry[]
}

/** 默认空统计 */
export function emptyStats(): StatsFile {
  return {
    totalRounds: 0,
    totalCandidates: 0,
    adopted: 0,
    skipped: 0,
    duplicated: 0,
    byCategory: {},
    history: [],
  }
}

/** 历史动作保留上限（避免文件无限增长） */
const MAX_HISTORY = 200

/** 读取统计文件；不存在/损坏时返回空统计（不抛错） */
export async function loadStats(ctx: Context): Promise<StatsFile> {
  const path = statsFilePath(ctx)
  try {
    const raw = await fs.readFile(path, 'utf8')
    const data = JSON.parse(raw)
    return {
      totalRounds: Number(data.totalRounds) || 0,
      totalCandidates: Number(data.totalCandidates) || 0,
      adopted: Number(data.adopted) || 0,
      skipped: Number(data.skipped) || 0,
      duplicated: Number(data.duplicated) || 0,
      byCategory: data.byCategory && typeof data.byCategory === 'object' ? data.byCategory : {},
      history: Array.isArray(data.history) ? data.history.slice(-MAX_HISTORY) : [],
    }
  } catch {
    return emptyStats()
  }
}

/** 写回统计文件（确保目录存在) */
async function saveStats(ctx: Context, stats: StatsFile): Promise<void> {
  const path = statsFilePath(ctx)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, JSON.stringify(stats, null, 2), 'utf8')
}

/** 记录提炼轮次完成（轮数 + 本轮候选条数） */
export async function recordRound(ctx: Context, candidates: PendingCandidate[]): Promise<void> {
  const stats = await loadStats(ctx)
  stats.totalRounds += 1
  stats.totalCandidates += candidates.length
  for (const c of candidates) {
    const cat = stats.byCategory[c.category] || { adopted: 0, skipped: 0, total: 0 }
    cat.total += 1
    stats.byCategory[c.category] = cat
  }
  await saveStats(ctx, stats)
}

/** 记录候选动作（采纳/跳过/查重命中）；clear 仅记一条动作（不调整分类统计，口径从简） */
export async function recordAction(
  ctx: Context,
  action: StatsEntry['action'],
  candidate: PendingCandidate | null,
): Promise<void> {
  const stats = await loadStats(ctx)
  if (action === 'adopt') stats.adopted += 1
  else if (action === 'skip') stats.skipped += 1
  else if (action === 'duplicate') stats.duplicated += 1

  const entry: StatsEntry = {
    action,
    candidateId: candidate?.id ?? '-',
    category: candidate?.category ?? '-',
    confidence: candidate?.confidence ?? 0,
    timestamp: Date.now(),
  }
  if (candidate) {
    const cat = stats.byCategory[candidate.category] || { adopted: 0, skipped: 0, total: 0 }
    if (action === 'adopt') cat.adopted += 1
    else if (action === 'skip') cat.skipped += 1
    stats.byCategory[candidate.category] = cat
  }
  stats.history.push(entry)
  if (stats.history.length > MAX_HISTORY) stats.history = stats.history.slice(-MAX_HISTORY)
  await saveStats(ctx, stats)
}

/** 生成统计展示文本（供「行为 统计」指令） */
export function formatStats(stats: StatsFile): string {
  const adoptRate = stats.adopted + stats.skipped > 0 ? Math.round((stats.adopted / (stats.adopted + stats.skipped)) * 100) : 0
  const lines: string[] = [
    '【行为统计】',
    `提炼轮次：${stats.totalRounds} 轮 · 累计候选 ${stats.totalCandidates} 条`,
    `采纳 ${stats.adopted} · 跳过 ${stats.skipped} · 查重命中 ${stats.duplicated} · 采纳率 ${adoptRate}%`,
  ]
  const cats = Object.entries(stats.byCategory).sort((a, b) => b[1].total - a[1].total)
  if (cats.length) {
    lines.push('')
    lines.push('【分类分布】')
    for (const [cat, c] of cats) {
      const rate = c.adopted + c.skipped > 0 ? Math.round((c.adopted / (c.adopted + c.skipped)) * 100) : 0
      lines.push(`${cat}：共 ${c.total} · 采纳 ${c.adopted} · 跳过 ${c.skipped} · 采纳率 ${rate}%`)
    }
  }
  if (stats.history.length) {
    const recent = stats.history.slice(-5).reverse()
    lines.push('')
    lines.push('【最近动作】')
    for (const h of recent) {
      const label = h.action === 'adopt' ? '采纳' : h.action === 'skip' ? '跳过' : h.action === 'duplicate' ? '查重命中' : '清空'
      lines.push(`${h.timestamp ? new Date(h.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''} ${label} ${h.candidateId} [${h.category}] 置信度 ${h.confidence.toFixed(2)}`)
    }
  }
  return lines.join('\n')
}
