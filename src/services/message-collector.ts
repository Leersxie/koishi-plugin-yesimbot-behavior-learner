import type { Context, Logger } from 'koishi'
import { TableName } from 'koishi-plugin-yesimbot'
import type { Config } from '../config'
import type { PendingCandidate } from './pending-store'
import { formatTime, HIGHLIGHT_KEYWORDS, todayBounds, tsToDate } from '../utils'

/**
 * 当天消息采集。
 *
 * 复用 livingdiary memory-collector 已验证的按日直查方式（定死约束，不发明新查询）：
 *   ctx.database.get(TableName.Messages, { platform, channelId, timestamp: { $gte: start, $lt: end } }, ['sender', 'content', 'timestamp'])
 * livingdiary 返回 MessageData[]，字段 sender{id,name} / content / timestamp。timestamp 为 ms epoch（已实测）。
 * 返回结构：直接给出消息数组（素材数组），无需二次解析 —— 本模块已按栏目归一化为 FlatMessage。
 *
 * token 截断：预算 8K（可配），优先保留 ①最新 ②含「纠正/别/不要/讨厌/夸」关键词者，
 * 从新到旧填充，超限丢最老。
 */

/** 归一化后的当天消息（供提炼素材） */
export interface FlatMessage {
  /** 平台 */
  platform: string
  /** 频道 ID */
  channelId: string
  /** 发送者名称（无则取 id） */
  senderName: string
  /** 消息正文 */
  content: string
  /** 消息时间（HH:mm） */
  time: string
  /** 原始时间对象（排序用） */
  timestamp: Date
}

/** 解析 "platform:channelId" 配置项 */
export function parseChannelCid(entry: string): { platform: string; channelId: string } | null {
  const idx = entry.indexOf(':')
  if (idx <= 0) return null
  return { platform: entry.slice(0, idx), channelId: entry.slice(idx + 1) }
}

/**
 * 按日取单频道消息（左闭右开 [start, end)）。
 * 与 livingdiary memory-collector 相同的表与条件；sender 为对象直接可用。
 */
async function queryChannelDay(
  ctx: Context,
  platform: string,
  channelId: string,
  start: Date,
  end: Date,
  limit: number,
  logger: Logger,
): Promise<FlatMessage[]> {
  const db = ctx.database
  if (!db) {
    logger.warn('[行为采集] 无数据库服务，跳过当天消息查询')
    return []
  }
  try {
    const rows = await db.get(
      TableName.Messages,
      { platform, channelId, timestamp: { $gte: start, $lt: end } },
      { fields: ['sender', 'content', 'timestamp'], limit },
    )
    return rows
      .map((row) => {
        const ts = tsToDate(row.timestamp as number | Date)
        return {
          platform,
          channelId,
          senderName: (row.sender as { name?: string; id?: string } | undefined)?.name || (row.sender as { id?: string } | undefined)?.id || '未知',
          content: String(row.content ?? '').trim(),
          time: formatTime(ts),
          timestamp: ts,
        }
      })
      .filter((m) => m.content && m.senderName !== '未知')
      // 升序（素材按时间正序给模型，证据才能对应原文时间）
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  } catch (error) {
    logger.warn(`[行为采集] 频道 ${platform}:${channelId} 查询失败：${(error as Error).message}`)
    return []
  }
}

/** 估算文本 token 数（中英混排粗略值：1 汉字 ≈ 1 token，纯字符流按 2/3 折算） */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const other = text.length - cjk
  return cjk + Math.ceil(other / 3)
}

/**
 * token 截断：从新到旧填充，优先保留含关键词者。
 * 实现：先把消息按时间降序；含关键词的「提升权重」但仍按从新到旧顺序分配。
 * 预算内装不下的丢弃最老（在降序中即末尾者）。
 */
export function truncateByBudget(messages: FlatMessage[], budget: number): FlatMessage[] {
  if (!messages.length) return []
  // 降序（新 → 旧）
  const desc = [...messages].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  // 关键词命中标记（不加分数，只做提权：命中关键词的消息优先于未命中，命中者内部仍按新→旧）
  const keyed = desc.filter((m) => HIGHLIGHT_KEYWORDS.some((k) => m.content.includes(k)))
  const rest = desc.filter((m) => !HIGHLIGHT_KEYWORDS.some((k) => m.content.includes(k)))
  const ordered = [...keyed, ...rest]
  const kept: FlatMessage[] = []
  let used = 0
  for (const msg of ordered) {
    const cost = estimateTokens(msg.content) + 2 // 每条加少量结构开销
    if (used + cost > budget && kept.length) break // 至少保留一条最新
    if (used + cost > budget) break
    kept.push(msg)
    used += cost
  }
  // 保证输出顺序为从新到旧（用于向上层展示最近优先），再反转成自然时间序给模型
  return kept.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

/** 格式化素材文本（供提炼 prompt） */
export function formatMaterials(messages: FlatMessage[]): string {
  return messages
    .map((m) => `[${m.time}] ${m.senderName}: ${m.content}`)
    .join('\n')
}

/**
 * 采集全部配置频道的当天消息并截断。
 * 返回 { messages: FlatMessage[], channelCount: number }；当天无法采集返回空。
 */
export async function collectTodayMessages(
  ctx: Context,
  config: Config,
  logger: Logger,
): Promise<{ messages: FlatMessage[]; channelCount: number }> {
  if (!config.instructorChannel.length) {
    logger.debug('[行为采集] 未配置 instructorChannel，跳过本轮')
    return { messages: [], channelCount: 0 }
  }
  const { start, end } = todayBounds()
  const all: FlatMessage[] = []
  let channelCount = 0
  for (const entry of config.instructorChannel) {
    const parsed = parseChannelCid(entry)
    if (!parsed) {
      logger.warn(`[行为采集] 忽略非法频道配置：${entry}（应为 platform:channelId）`)
      continue
    }
    const day = await queryChannelDay(ctx, parsed.platform, parsed.channelId, start, end, config.maxMessagesPerChannel, logger)
    if (day.length) {
      channelCount++
      all.push(...day)
    }
  }
  if (!all.length) return { messages: [], channelCount }
  const budget = config.tokenBudget || 8000
  // 按频道各自截断再合并，避免单个大频道挤爆预算
  const perChannel = config.tokenBudget / Math.max(1, channelCount)
  const truncated: FlatMessage[] = []
  for (const entry of config.instructorChannel) {
    const parsed = parseChannelCid(entry)
    if (!parsed) continue
    const day = all.filter((m) => m.platform === parsed.platform && m.channelId === parsed.channelId)
    if (!day.length) continue
    truncated.push(...truncateByBudget(day, Math.max(1000, perChannel)))
  }
  const total = estimateTokens(truncated.map((m) => m.content).join(''))
  logger.debug(`[行为采集] 当天消息 ${all.length} 条，截断后 ${truncated.length} 条（约 ${total} tokens）`)
  return { messages: truncated, channelCount }
}

export function candidateFromMessage(message: FlatMessage): Pick<PendingCandidate, 'channelCid' | 'time'> {
  return { channelCid: `${message.platform}:${message.channelId}`, time: message.time }
}
