import type { Context, Logger } from 'koishi'
import type { Config } from '../config'
import type { PendingCandidate } from './pending-store'
import { truncate } from '../utils'

/**
 * 候选私聊推送。
 *
 * 目标：notifyTarget（string[]），格式二选一：
 * - "platform:userId"：按平台匹配对应 platform 的在线机器人（避免多 bot 选错）；
 * - "userId"：找不到平台信息时，退化为任意在线机器人。
 *
 * 降级链（定死）：
 *   1) bot.sendPrivateMessage(userId, text)
 *   2) 失败 → bot.sendMessage('private:' + userId, text)（OneBot 等支持 private: 前缀）
 *   3) 仍失败 → 在 instructorChannel 任意频道的最后一条消息上下文不可行（无 session），
 *      仅 warn 日志并标记不可达，不重试。
 *
 * 无私信权限：直接 warn 且不重试（不发频道 @ 打扰群聊，保持可控）。
 */

/** 解析推送目标：platform:userId 或 userId */
export function parseNotifyTarget(target: string): { platform: string | null; userId: string } {
  const idx = target.indexOf(':')
  if (idx <= 0) {
    return { platform: null, userId: target }
  }
  const platform = target.slice(0, idx)
  const userId = target.slice(idx + 1)
  // 平台字段判空视为纯 userId
  return { platform: platform || null, userId: userId || target }
}

/** 组装候选推送文案 */
export function buildNotification(candidates: PendingCandidate[], round: number): string {
  const lines: string[] = [`【行为候选 · 第 ${round} 轮】`, '本轮候选已生成，若与上一轮编号冲突则以本轮为准（旧编号作废）。请回复「行为 采纳 <ID>」或「行为 跳过 <ID>」。', '']
  for (const c of candidates) {
    const mark = c.confidence >= 0.8 ? '建议采纳' : '建议确认'
    lines.push(
      `${c.id} [${c.category}] ${c.text}`,
      `　证据：「${truncate(c.evidence, 60)}」(${c.time}) · ${mark} · 来源 ${c.channelCid}`,
      '',
    )
  }
  return lines.join('\n')
}

/** 旧编号作废提示（新轮生成时若有旧候选） */
export function buildSupersedeNotice(): string {
  return '【行为候选】本轮候选已更新，旧编号全部作废；仅最新一轮候选可采纳。'
}

/** 选择推送机器人：优先按 platform 精确匹配在线的；否则任意在线（matchedPlatform=false 供上层 warn） */
export interface PickResult {
  bot: any
  /** 是否命中指定 platform；false = 平台不匹配时的任意在线降级 */
  matchedPlatform: boolean
}

export function pickBot(ctx: Context, platform: string | null): PickResult | null {
  const bots = ctx.bots?.filter((b: any) => b.online)
  if (!bots?.length) return null
  if (platform) {
    const exact = bots.find((b: any) => b.platform === platform)
    if (exact) return { bot: exact, matchedPlatform: true }
  }
  const fallback = bots[0]
  if (fallback) return { bot: fallback, matchedPlatform: false }
  return null
}

/** 发送私聊推送；返回是否成功 */
export async function notifyCandidate(
  ctx: Context,
  config: Config,
  candidates: PendingCandidate[],
  round: number,
  logger: Logger,
): Promise<void> {
  if (!config.notifyTarget.length) {
    logger.warn('[行为推送] notifyTarget 未配置，候选仅在 pending 文件暂存，无人确认。')
    return
  }
  const text = buildNotification(candidates, round)
  for (const target of config.notifyTarget) {
    const { platform, userId } = parseNotifyTarget(target)
    const picked = pickBot(ctx, platform)
    if (!picked) {
      logger.warn(`[行为推送] 无可用在线机器人（目标 ${target}），跳过推送`)
      continue
    }
    if (platform && !picked.matchedPlatform) {
      logger.warn(
        `[行为推送] 目标 ${target} 指定平台 ${platform} 无在线机器人，已降级为任意在线机器人 ${picked.bot.platform}#${picked.bot.selfId}`,
      )
    }
    const { bot } = picked
    // 1) sendPrivateMessage
    try {
      await bot.sendPrivateMessage(userId, text)
      continue
    } catch (error) {
      logger.warn(`[行为推送] sendPrivateMessage 失败（目标 ${target}）：${(error as Error).message}，尝试降级`)
    }
    // 2) sendMessage + private: 前缀
    try {
      await bot.sendMessage(`private:${userId}`, text)
      continue
    } catch (error) {
      logger.warn(`[行为推送] 降级 sendMessage private: 也失败（目标 ${target}）：${(error as Error).message}`)
    }
    // 3) 均失败：仅 warn，不重试、不发频道 @ （保持可控，避免群聊骚扰）
    logger.warn(`[行为推送] 目标 ${target} 私信不可达，已放弃本轮通知（不重试）`)
  }
}

/** 通知"文件被外部修改，本轮自动合并已放弃"（会话内提示由指令处理，这里仅日志 + 私聊兜底） */
export async function notifyExternalModification(
  ctx: Context,
  config: Config,
  text: string,
  logger: Logger,
): Promise<void> {
  if (!config.notifyTarget.length) return
  for (const target of config.notifyTarget) {
    const { platform, userId } = parseNotifyTarget(target)
    const picked = pickBot(ctx, platform)
    if (!picked) continue
    try {
      await picked.bot.sendPrivateMessage(userId, text)
    } catch {
      logger.warn('[行为推送] 外部修改通知私聊发送失败')
    }
  }
}
