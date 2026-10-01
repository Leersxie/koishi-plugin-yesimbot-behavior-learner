import type { Context, Logger } from 'koishi'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pendingFilePath } from '../paths'

/**
 * 候选暂存（behavior.pending.json）读写与清理。
 *
 * 候选不写进 behavior.md，而是独立 JSON 文件，位于 <baseDir>/data/yesimbot/memory/ 根目录
 * （【不在 core 目录】，避免未确认候选被注入上下文 —— 定死约束）。
 * 文件结构与内容：
 * {
 *   "round": 3,                    // 当前轮次号
 *   "behaviorHash": "...",         // 本轮候选生成时 behavior.md 的内容 hash（防外部修改）
 *   "candidates": [                // 本轮候选列表（旧轮候选生成下一轮即作废）
 *     { "id": "b3-1", "category": "说话风格", "text": "...", "evidence": "原文…", "time": "HH:mm",
 *       "confidence": 0.9, "createdAt": 国际时间戳, "channelCid": "platform:channelId" }
 *   ]
 * }
 */

/** 单个候选条目 */
export interface PendingCandidate {
  /** 候选 ID = 轮次 + 序号，如 b3-1 */
  id: string
  /** 建议写入的分类 */
  category: string
  /** 条目正文（不含 "* [标签] " 前缀） */
  text: string
  /** 证据（引用当天原文） */
  evidence: string
  /** 证据时间 HH:mm */
  time: string
  /** 模型自信度 0~1 */
  confidence: number
  /** 候选生成时间（ms epoch），用于 48h TTL 判定 */
  createdAt: number
  /** 来源频道 platform:channelId */
  channelCid: string
}

/**
 * 已采纳记录（撤销栈元素）。
 * 「行为 撤销」回滚最近一次合并：恢复合并前的备份内容，并把该候选重新放回 candidates，
 * 使其可被再次采纳 —— 定死约束（见用户第二轮 4 号修正，撤销后不得直接删除）。
 */
export interface AcceptedEntry {
  /** 被采纳的候选（撤销时原样恢复） */
  candidate: PendingCandidate
  /** 合并前 behavior.md 的备份文件路径（撤销时恢复该备份） */
  backupPath: string
}

/** pending 文件整体结构 */
export interface PendingFile {
  round: number
  /** 候选生成（或最近一次采纳/撤销）时的 behavior.md 内容 hash */
  behaviorHash: string
  candidates: PendingCandidate[]
  /** 撤销栈：最近一次采纳在末尾，最多保留 backupKeep 层（支持连续回滚） */
  acceptedStack: AcceptedEntry[]
}

/** 默认空文件结构 */
function emptyFile(): PendingFile {
  return { round: 0, behaviorHash: '', candidates: [], acceptedStack: [] }
}

/** 读取 pending 文件；不存在/损坏时返回空文件（不抛错） */
export async function loadPending(ctx: Context): Promise<PendingFile> {
  const path = pendingFilePath(ctx)
  try {
    const raw = await fs.readFile(path, 'utf8')
    const data = JSON.parse(raw)
    return {
      round: Number(data.round) || 0,
      behaviorHash: typeof data.behaviorHash === 'string' ? data.behaviorHash : '',
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      // 撤销栈逐项校验，损坏项丢弃
      acceptedStack: Array.isArray(data.acceptedStack)
        ? data.acceptedStack.filter(
            (e: any) => e && typeof e === 'object' && e.candidate && typeof e.backupPath === 'string',
          )
        : [],
    }
  } catch {
    return emptyFile()
  }
}

/** 写回 pending 文件（确保目录存在） */
export async function savePending(ctx: Context, file: PendingFile): Promise<void> {
  const path = pendingFilePath(ctx)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, JSON.stringify(file, null, 2), 'utf8')
}

/**
 * 候选过期清理：删除超过 TTL 的候选（等价跳过）。
 * 返回被清理的候选 ID 列表。
 */
export async function purgeExpired(ctx: Context, ttlHours: number): Promise<string[]> {
  const file = await loadPending(ctx)
  if (!file.candidates.length) return []
  const now = Date.now()
  const valid = file.candidates.filter((c) => now - c.createdAt <= ttlHours * 3600 * 1000)
  const removed = file.candidates.filter((c) => now - c.createdAt > ttlHours * 3600 * 1000).map((c) => c.id)
  if (removed.length) {
    file.candidates = valid
    await savePending(ctx, file)
  }
  return removed
}

/** 当前是否还有未过期候选（用于无感知轮跳过提示与指令空态判断） */
export async function hasPending(ctx: Context, ttlHours: number): Promise<boolean> {
  const file = await loadPending(ctx)
  const now = Date.now()
  return file.candidates.some((c) => now - c.createdAt <= ttlHours * 3600 * 1000)
}

/** 取单个候选（按 ID）；不存在返回 undefined */
export async function getPending(ctx: Context, ttlHours: number, id: string): Promise<PendingCandidate | undefined> {
  const file = await loadPending(ctx)
  const now = Date.now()
  return file.candidates.find((c) => c.id === id && now - c.createdAt <= ttlHours * 3600 * 1000)
}

/** 列出全部未过期候选（按 ID 排序） */
export async function listPending(ctx: Context, ttlHours: number): Promise<PendingCandidate[]> {
  const file = await loadPending(ctx)
  const now = Date.now()
  return file.candidates.filter((c) => now - c.createdAt <= ttlHours * 3600 * 1000).sort((a, b) => a.id.localeCompare(b.id))
}

/** 删除单个候选（跳过）；不存在不报错 */
export async function removePending(ctx: Context, id: string): Promise<void> {
  const file = await loadPending(ctx)
  file.candidates = file.candidates.filter((c) => c.id !== id)
  await savePending(ctx, file)
}

/** 清空全部候选（全跳过）；保留 round/hash/撤销栈（不影响历史撤销） */
export async function clearCandidates(ctx: Context): Promise<void> {
  const file = await loadPending(ctx)
  file.candidates = []
  await savePending(ctx, file)
}

/** 清空全部候选与撤销栈（完全重置，一般不用） */
export async function clearPending(ctx: Context): Promise<void> {
  const file = emptyFile()
  await savePending(ctx, file)
}

/** 记录当前 round 与新候选；旧轮候选直接覆盖（作废）。保留 behaviorHash 供采纳时防冲突校验 */
export async function storeRound(
  ctx: Context,
  behaviorHash: string,
  candidates: PendingCandidate[],
  round: number,
  logger: Logger,
): Promise<void> {
  const file = { round, behaviorHash, candidates, acceptedStack: [] }
  await savePending(ctx, file)
  logger.info(`候选已暂存（轮次 ${round}，共 ${candidates.length} 条）`)
}

/** 更新 pending 的 behaviorHash（采纳/撤销后校准防冲突基线） */
export async function updateBehaviorHash(ctx: Context, behaviorHash: string): Promise<void> {
  const file = await loadPending(ctx)
  file.behaviorHash = behaviorHash
  await savePending(ctx, file)
}

/**
 * 记录一次采纳（压入撤销栈，栈尾为最近一次）。
 * maxLen = backupKeep：超出时丢弃最旧的记录（与备份环形数量对齐，保证 backup 文件仍在）。
 */
export async function pushAccepted(ctx: Context, entry: AcceptedEntry, maxLen: number): Promise<void> {
  const file = await loadPending(ctx)
  file.acceptedStack.push(entry)
  while (file.acceptedStack.length > Math.max(1, maxLen)) file.acceptedStack.shift()
  await savePending(ctx, file)
}

/**
 * 弹出最近一次采纳记录（撤销时消费）。
 * 返回被弹出的记录；栈为空返回 undefined。
 */
export async function popAccepted(ctx: Context): Promise<AcceptedEntry | undefined> {
  const file = await loadPending(ctx)
  const entry = file.acceptedStack.pop()
  if (entry) await savePending(ctx, file)
  return entry
}

/** 撤销后把候选重新放回待确认（刷新 createdAt 使其重新进入 TTL，可再次采纳） */
export async function restoreCandidate(ctx: Context, candidate: PendingCandidate): Promise<void> {
  candidate.createdAt = Date.now()
  const file = await loadPending(ctx)
  if (!file.candidates.some((c) => c.id === candidate.id)) file.candidates.push(candidate)
  await savePending(ctx, file)
}

/** 移除指定 backupPath 的撤销栈记录（备份文件已被补救/删除时防止悬空引用） */
export async function dropAcceptedByBackup(ctx: Context, backupPath: string): Promise<void> {
  const file = await loadPending(ctx)
  const before = file.acceptedStack.length
  file.acceptedStack = file.acceptedStack.filter((e) => e.backupPath !== backupPath)
  if (file.acceptedStack.length !== before) await savePending(ctx, file)
}
