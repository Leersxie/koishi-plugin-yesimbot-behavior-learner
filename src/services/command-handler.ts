import type { Context, Logger, Session } from 'koishi'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config'
import { backupsDir, behaviorFilePath } from '../paths'
import { hashContent, timestampForBackup, truncate } from '../utils'
import {
  ensureBehaviorFile,
  hashBehavior,
  mergeIntoSection,
  parseBehavior,
  readBehavior,
  restoreFromBackup,
  serializeBehavior,
  writeBehavior,
} from './behavior-file'
import type { BehaviorCategory } from './behavior-file'
import { BEHAVIOR_SECTIONS } from './behavior-file'
import {
  clearCandidates,
  getPending,
  listPending,
  loadPending,
  popAccepted,
  pushAccepted,
  removePending,
  restoreCandidate,
  updateBehaviorHash,
} from './pending-store'
import type { PendingCandidate } from './pending-store'
import { formatStats, loadStats, recordAction } from './stats-store'

/**
 * 「行为」指令组。
 *
 * 一期指令（全部要求白名单权限）：
 * - 行为 采纳 <ID>             → 采纳候选，写入 behavior.md 对应章节（先备份，防外部修改）
 * - 行为 采纳 <ID> 改为：xxx   → 采纳但替换条目内容
 * - 行为 跳过 <ID>             → 跳过候选（仅从 pending 移除）
 * - 行为 全跳过                → 清空全部待确认候选
 * - 行为 查看                  → 列出待确认候选 + 外部修改告警
 * - 行为 撤销                  → 回滚最近一次合并（恢复备份 + 候选回到待确认，可重新采纳）
 * - 行为 导出                  → 导出行为文件（当前行为准则）为 Markdown/JSON，写入备份目录
 * - 行为 统计                  → 查看采纳率/跳过率/分类分布与最近动作
 *
 * 权限：allowUserIds 有值则仅这些 userId；留空则仅超级管理员（authority >= 3）。
 * 并发防冲突：每次写入前重读最新文件 + 重算 hash，与候选生成时的 behaviorHash 对比，
 * 不一致则放弃自动合并（只弹提示，不强行合并、不覆盖用户新增内容 —— 定死约束）。
 */

/** 「改为：xxx」解析结果：null = 无修改要求；'' = 格式非法；其他 = 新内容 */
function parseChangeRest(rest: string | undefined): string | null | '' {
  if (rest === undefined || rest === null) return null
  const text = rest.trim()
  if (!text) return null
  const m = text.match(/^改为[：:]\s*(.*)$/)
  return m ? (m[1] ?? '').trim() : ''
}

/** 白名单判定（公共）：allowUserIds 有值仅名单可用；留空仅超级管理员（authority>=3） */
export function isUserAllowed(config: Config, session: Session | undefined | null): boolean {
  if (!session?.userId) return false
  if (config.allowUserIds.length) return config.allowUserIds.includes(session.userId)
  const authority = (session.user as { authority?: number } | undefined)?.authority ?? 0
  return authority >= 3
}

export class CommandHandler {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.register()
  }

  /** 注册指令组（子命令之间互相独立，root 仅作分组说明） */
  private register(): void {
    this.ctx
      .command('行为', '行为学习器：管理待确认候选（采纳/跳过/查看/撤销）')
      .action(async ({ session }) => {
        if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
        return this.view(session)
      })

    this.ctx
      .command('行为.采纳 <id:string> [rest:text]', '采纳候选；可追加「改为：xxx」替换条目标题内容')
      .action(async ({ session }, id, rest) => {
        if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
        const change = parseChangeRest(rest)
        if (change === '') return '参数格式不正确：使用「行为 采纳 <ID> 改为：xxx」'
        return this.adopt(session, id, change)
      })

    this.ctx
      .command('行为.跳过 <id:string>', '跳过候选（仅从待确认移除，不写入行为文件）')
      .action(async ({ session }, id) => {
        if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
        return this.skip(session, id)
      })

    this.ctx.command('行为.全跳过', '清空全部待确认候选').action(async ({ session }) => {
      if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
      await clearCandidates(this.ctx)
      await recordAction(this.ctx, 'clear', null)
      this.logger.info(`[行为指令] 用户 ${session!.userId} 执行全跳过`)
      return '已跳过全部待确认候选'
    })

    this.ctx.command('行为.查看', '查看待确认候选与行为文件状态').action(async ({ session }) => {
      if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
      return this.view(session)
    })

    this.ctx.command('行为.撤销', '回滚最近一次合并（候选重新回到待确认，可再次采纳）').action(async ({ session }) => {
      if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
      return this.undo(session)
    })

    this.ctx.command('行为.导出', '导出行为文件（当前行为准则）为 Markdown/JSON，写入备份目录').action(async ({ session }) => {
      if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
      await this.exportBehavior()
      return `已导出行为文件到 ${backupsDir(this.ctx)}/（原文件未改动）`
    })

    this.ctx.command('行为.统计', '查看行为提炼的采纳率/跳过率/分类分布与最近动作').action(async ({ session }) => {
      if (!this.isAllowed(session)) return '你没有权限使用「行为」指令'
      const stats = await loadStats(this.ctx)
      return formatStats(stats)
    })
  }

  /** 白名单判定：allowUserIds 有值仅名单可用；留空仅超级管理员（authority>=3） */
  private isAllowed(session: Session | undefined | null): boolean {
    return isUserAllowed(this.config, session)
  }

  // ==================== 采纳 ====================

  /** 采纳：校验 hash → 合并 → 备份 → 回显 diff；「改为：xxx」传入 change */
  private async adopt(session: Session | undefined, id: string, change: string | null): Promise<string> {
    if (!session?.userId) return '没有可用的会话上下文'
    const pending = await loadPending(this.ctx)
    const candidate = pending.candidates.find((c) => c.id === id)
    if (!candidate) {
      return `候选 ${id} 不存在或已过期（有效期 ${this.config.candidateTtlHours} 小时），请先「行为 查看」确认编号`
    }

    // 读取最新文件并重算 hash（外部修改防线：只比内容 hash，不比 mtime）
    await ensureBehaviorFile(this.ctx, this.logger)
    const raw = await readBehavior(this.ctx)
    const currentHash = await hashContent(raw)
    if (pending.behaviorHash && currentHash !== pending.behaviorHash) {
      // 候选生成后至确认前文件被外部修改 → 放弃本轮自动合并，安全优先
      this.logger.warn(`[行为采纳] 候选 ${id} 生成后 behavior.md 被外部修改，放弃自动合并`)
      return '⚠️ 检测到 behavior.md 在候选生成后被手动修改（内容 hash 不一致），本候选未自动合并。请先手动处理文件后重试，或「行为 撤销」回滚。'
    }

    const doc = parseBehavior(raw)
    const category = candidate.category as BehaviorCategory
    // 「改为：xxx」：对修改后的内容做去重后写入，不碰文件已有条目（候选在 pending 里，不在文件中）
    const result = mergeIntoSection(doc, category, change ?? candidate.text)

    // 与已有条目相似度 > 0.8 → 跳过写入；候选视为已消化，从 pending 移除
    if (result.action === 'duplicate') {
      await removePending(this.ctx, id)
      await recordAction(this.ctx, 'duplicate', candidate)
      return `未写入：与「${category}」章节已有条目相似度过高（>0.8），已自动跳过该候选 ${id}`
    }

    // 合并成功：写回（内部自动备份到 backups/ + 环形清理）
    const backup = await writeBehavior(this.ctx, serializeBehavior(doc), this.config.backupKeep)
    // 记录撤销栈 + 校准 hash 基线 + 移除候选
    await pushAccepted(this.ctx, { candidate, backupPath: backup.path }, this.config.backupKeep)
    await removePending(this.ctx, id)
    // 统计：记录本次采纳（含置信度，供「行为 统计」算采纳率）
    await recordAction(this.ctx, 'adopt', candidate)
    const newHash = await hashBehavior(this.ctx)
    await updateBehaviorHash(this.ctx, newHash)

    // 回显 diff（「改为」直接展示写入的新内容）
    const mark = candidate.confidence >= 0.8 ? '建议采纳' : '建议确认'
    const header = `✅ 已采纳 ${id} [${category}]\n证据：「${truncate(candidate.evidence, 60)}」(${candidate.time}) · ${mark} · 来源 ${candidate.channelCid}`
    return `${header}\n${change ? `已改为：${result.targetLines[0]}` : `已写入：${result.targetLines[0]}`}`
  }

  // ==================== 跳过 ====================

  private async skip(session: Session | undefined, id: string): Promise<string> {
    if (!session?.userId) return '没有可用的会话上下文'
    const candidate = await getPending(this.ctx, this.config.candidateTtlHours, id)
    if (!candidate) {
      return `候选 ${id} 不存在或已过期，请先「行为 查看」确认编号`
    }
    await removePending(this.ctx, id)
    await recordAction(this.ctx, 'skip', candidate)
    this.logger.info(`[行为指令] 用户 ${session.userId} 跳过候选 ${id}`)
    return `已跳过候选 ${id} [${candidate.category}]：${truncate(candidate.text, 40)}`
  }

  // ==================== 查看 ====================

  private async view(session: Session | undefined): Promise<string> {
    const pending = await loadPending(this.ctx)
    const candidates = await listPending(this.ctx, this.config.candidateTtlHours)
    if (!candidates.length) {
      // 无候选时若检测到文件被外部修改，仍提示一次（避免用户误以为行为文件已同步）
      if (pending.behaviorHash) {
        const currentHash = await hashBehavior(this.ctx).catch(() => '')
        if (currentHash && currentHash !== pending.behaviorHash) {
          return '当前没有待确认候选。\n⚠️ 检测到 behavior.md 已被手动修改（与候选生成时不一致），如需回滚可「行为 撤销」。'
        }
      }
      return `当前没有待确认候选（有效期 ${this.config.candidateTtlHours} 小时）。`
    }
    const lines: string[] = []
    for (const c of candidates) {
      const remaining = Math.max(0, Math.ceil((c.createdAt + this.config.candidateTtlHours * 3600 * 1000 - Date.now()) / 3600 / 1000))
      const mark = c.confidence >= 0.8 ? '建议采纳' : '建议确认'
      lines.push(`${c.id} [${c.category}] ${c.text}`)
      lines.push(`　证据：「${truncate(c.evidence, 60)}」(${c.time}) · ${mark} · 来源 ${c.channelCid} · 剩余 ${remaining}h`)
    }
    lines.push('')
    lines.push('回复「行为 采纳 <ID>」采纳；「行为 采纳 <ID> 改为：xxx」采纳并改内容；「行为 跳过 <ID>」跳过；「行为 全跳过」「行为 撤销」。')
    // 外部修改告警
    if (pending.behaviorHash) {
      const currentHash = await hashBehavior(this.ctx).catch(() => '')
      if (currentHash && currentHash !== pending.behaviorHash) {
        lines.push('')
        lines.push('⚠️ 检测到 behavior.md 已被手动修改（与候选生成时 hash 不一致），采纳将放弃自动合并，请先手动处理。')
      }
    }
    return lines.join('\n')
  }

  // ==================== 导出 ====================

  /** 导出行为文件：Markdown 原样复制 + JSON 结构化视图，写入 backups/（.md.bak / .json 不注入 core） */
  private async exportBehavior(): Promise<void> {
    await ensureBehaviorFile(this.ctx, this.logger)
    const raw = await readBehavior(this.ctx)
    const doc = parseBehavior(raw)
    const stamp = timestampForBackup()
    const dir = backupsDir(this.ctx)
    await fs.mkdir(dir, { recursive: true })

    // 1) Markdown：原文件内容（同样 .md.bak 后缀，避开 core 扫描注入）
    const mdPath = join(dir, `behavior.export-${stamp}.md.bak`)
    await fs.writeFile(mdPath, raw, 'utf8')

    // 2) JSON：结构化章节视图（条目列表 + 原始内容），便于程序化迁移
    const json: Record<string, string[]> = {}
    for (const cat of BEHAVIOR_SECTIONS) {
      const view = doc.sections.get(cat)
      json[cat] = view?.items ?? []
    }
    const jsonPath = join(dir, `behavior.export-${stamp}.json`)
    await fs.writeFile(jsonPath, JSON.stringify({ exportedAt: new Date().toISOString(), sections: json }, null, 2), 'utf8')

    this.logger.info(`[行为导出] 已导出 Markdown（${mdPath}）与 JSON（${jsonPath}）`)
  }

  // ==================== 撤销 ====================

  /** 撤销：恢复最近一次合并前的备份内容 + 候选重新进入待确认（可再次采纳） */
  private async undo(session: Session | undefined): Promise<string> {
    if (!session?.userId) return '没有可用的会话上下文'
    const entry = await popAccepted(this.ctx)
    if (!entry) return '没有可回滚的合并记录（未采纳过候选，或已达最大回滚次数）'
    try {
      // 读取备份内容并恢复（直接写回，不额外制造备份；消费这条备份）
      const backupText = await restoreFromBackup(entry.backupPath)
      await fs.writeFile(behaviorFilePath(this.ctx), backupText, 'utf8')
      // 恢复后校准 hash 基线
      const newHash = await hashContent(backupText)
      await updateBehaviorHash(this.ctx, newHash)
      // 候选重新进入待确认（刷新 TTL）
      await restoreCandidate(this.ctx, entry.candidate)
      return `↩️ 已回滚最近一次合并。候选 ${entry.candidate.id} [${entry.candidate.category}] 已恢复至待确认，可重新「行为 采纳」。`
    } catch (error) {
      // 备份缺失等异常：不丢数据 —— 候选仍放回待确认，文件回滚交给手动处理
      this.logger.warn(`[行为撤销] 回滚失败：${(error as Error).message}`)
      await restoreCandidate(this.ctx, entry.candidate)
      return `回滚失败（${(error as Error).message}）。候选 ${entry.candidate.id} 已放回待确认，请手动核对行为文件。`
    }
  }
}
