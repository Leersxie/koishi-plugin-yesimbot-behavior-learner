import type { Context, Logger } from 'koishi'
import type { Config } from '../config'
import { ensureBehaviorFile, hashBehavior } from './behavior-file'
import { extractCandidates, ExtractionError } from './extractor'
import type { ModelCandidate } from './extractor'
import { collectTodayMessages, formatMaterials } from './message-collector'
import type { FlatMessage } from './message-collector'
import { notifyCandidate } from './notifier'
import { loadPending, purgeExpired, storeRound } from './pending-store'
import type { PendingCandidate } from './pending-store'

/**
 * 每日行为提炼调度器。
 *
 * 与 livingdiary DiaryScheduler 相同的调度范式：
 * - setTimeout 递归（非 setInterval），避免任务堆积；
 * - 每天配置时刻（默认 23:30）触发；错过触发时刻顺延次日，不补发；
 * - dispose 清理定时器。
 *
 * 一轮完整流程（定死顺序）：
 *   定时触发 → 清过期候选 → 按日查消息 → 空则静默跳过（仅 debug）
 *   → token 截断 → 提炼 JSON → 候选写入独立 pending 文件（不注入 core）
 *   → 私聊推送确认。采纳/跳过不在此处，由「行为」指令处理。
 *   新轮候选生成即覆盖旧候选（旧编号作废），推送文案自带作废说明。
 */

/** 为一轮提炼分配候选 ID，并按素材还原来源频道 */
export function buildPendingList(list: ModelCandidate[], round: number, messages: FlatMessage[]): PendingCandidate[] {
  const now = Date.now()
  return list.map((item, index) => {
    const content = (item.content ?? item.text ?? '').toString().trim()
    const evidence = (item.evidence ?? '').toString().trim()
    const time = (item.time ?? '').toString().trim()
    // 还原来源频道：优先取与证据/时间最匹配的那条消息
    const match = messages.find(
      (m) => (evidence && (m.content.includes(evidence) || evidence.includes(m.content.slice(0, 12)))) || (time && m.time === time),
    )
    const channelCid = match
      ? `${match.platform}:${match.channelId}`
      : messages[0]
        ? `${messages[0].platform}:${messages[0].channelId}`
        : ''
    return {
      id: `b${round}-${index + 1}`,
      category: (item.category ?? '').toString().trim(),
      text: content,
      evidence,
      time,
      confidence: typeof item.confidence === 'number' ? item.confidence : Number.parseFloat(String(item.confidence ?? '0.5')) || 0.5,
      createdAt: now,
      channelCid,
    }
  })
}

export class BehaviorScheduler {
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  /** 提炼运行中标志：防止定时触发与手动触发并发读写 pending / behavior.md */
  private running = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.scheduleEnabled) {
      this.logger.info('[行为调度] 每日提炼已停用（scheduleEnabled=false）')
      return
    }
    this.schedule()
  }

  /** 计算下一个触发时刻并递归调度；已过则顺延次日（错过不补发） */
  private schedule(): void {
    const [hour, minute] = this.config.scheduleTime.split(':').map(Number)
    const now = new Date()
    const next = new Date()
    next.setHours(hour, minute, 0, 0)
    if (now >= next) next.setDate(next.getDate() + 1)
    const delay = next.getTime() - now.getTime()
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, delay)
    this.logger.debug(`[行为调度] 下一次提炼：${next.toLocaleString()}`)
  }

  /** 手动触发一轮（调试用），与定时同一逻辑 */
  async runNow(): Promise<string> {
    return this.executeDaily()
  }

  private async run(): Promise<void> {
    try {
      await this.executeDaily()
    } catch (error) {
      this.logger.error(`[行为调度] 每日提炼异常：${(error as Error).message}`)
    } finally {
      if (!this.disposed) this.schedule()
    }
  }

  private async executeDaily(): Promise<string> {
    // 防并发：定时触发与手动触发可能同时到达，避免并发读写 pending / behavior.md
    if (this.running) {
      this.logger.warn('[行为调度] 上一轮提炼仍在进行，本次触发已跳过（防并发写入）')
      return '上一轮提炼仍在进行，本次已跳过'
    }
    this.running = true
    try {
      // 1) 先清过期候选（过期即删除 = 跳过，文件不会越积越脏）
      const removed = await purgeExpired(this.ctx, this.config.candidateTtlHours)
    if (removed.length) this.logger.info(`[行为调度] 清理过期候选：${removed.join('、')}（等价跳过）`)

    // 2) 按日采集（空则静默跳过，不打扰用户）
    const { messages } = await collectTodayMessages(this.ctx, this.config, this.logger)
    if (!messages.length) {
      this.logger.debug('[行为调度] 当天消息为空，静默跳过本轮（不推送）')
      return '当天消息为空，已跳过本轮提炼'
    }

    // 3) 提炼（prompt 硬约束在 extractor 内部；失败不自动重试，仅记录并放弃本轮）
    const materials = formatMaterials(messages)
    let list: ModelCandidate[]
    try {
      list = await extractCandidates(this.ctx, this.config, materials, this.logger)
    } catch (error) {
      if (error instanceof ExtractionError) {
        this.logger.warn(`[行为调度] 本轮提炼放弃：${error.message}`)
        return `提炼失败（${error.message}），本轮无候选`
      }
      this.logger.error(`[行为调度] 提炼异常：${(error as Error).message}`)
      return '提炼异常，本轮无候选'
    }
    const capped = list.slice(0, this.config.maxCandidates)
    if (!capped.length) {
      this.logger.warn('[行为调度] 本轮未提炼出有效候选（无证据/分类非法，已过滤）')
      return '本轮未提炼出有效候选'
    }

    // 4) 轮次 + 候选暂存（独立 pending 文件，不注入 core）
    const prev = await loadPending(this.ctx)
    const round = prev.round + 1
    const candidates = buildPendingList(capped, round, messages)
    if (prev.candidates.length) {
      this.logger.info('[行为调度] 上一轮候选已作废，本轮候选已生成（推送文案含作废说明）')
    }
    // 生成基线 hash：候选生成时 behavior.md 的内容 hash（采纳时防外部修改）
    await ensureBehaviorFile(this.ctx, this.logger)
    const behaviorHash = await hashBehavior(this.ctx)
    await storeRound(this.ctx, behaviorHash, candidates, round, this.logger)

    // 5) 私聊推送（逐目标降级链在 notifier 内部；失败仅 warn 不重试）
    await notifyCandidate(this.ctx, this.config, candidates, round, this.logger)
    return `已提炼 ${candidates.length} 条候选（轮次 ${round}）并推送确认`
    } finally {
      this.running = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
