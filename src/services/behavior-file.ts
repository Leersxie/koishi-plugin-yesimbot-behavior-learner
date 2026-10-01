import type { Context, Logger } from 'koishi'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config'
import { backupsDir, behaviorFilePath } from '../paths'
import { hashContent, similarity, timestampForBackup } from '../utils'

/**
 * 行为文档（behavior.md）读写与合并。
 *
 * 本模块只管 behavior.md 本身：
 * - 章节结构与条目解析（条目格式：* [标签] 内容）；
 * - 合并算法：同标签下相似度 > 0.8 跳过、否则追加；「改为：xxx」替换指定条目；
 * - 备份环形（backups/ 目录，keep 份）；合并前对原文件做 hash 快照，写回前重读+重算 hash，
 *   检测到外部修改则放弃本轮合并（只弹提示，不强行合并）；
 * - <!--locked--> 段落在提炼与合并阶段一律跳过。
 *
 * 【定死】外部修改检测只对比内容 hash，绝不比较 mtime（用户打开但不保存也会变 mtime）。
 */

/** 行为分类标签（与行为文件章节一一对应） */
export const BEHAVIOR_CATEGORIES = ['说话风格', '表达偏好', '禁忌与回避'] as const
export type BehaviorCategory = (typeof BEHAVIOR_CATEGORIES)[number]

/** 行为文件标准章节顺序（含「待确认」，尊重用户已有内容，不主动清空） */
export const BEHAVIOR_SECTIONS: BehaviorCategory[] = ['说话风格', '表达偏好', '禁忌与回避']

/** 章节标题 */
const SECTION_TITLES = [...BEHAVIOR_SECTIONS, '待确认']

/** 相似度阈值：同标签下高于该值跳过（定死 0.8） */
const DEDUP_THRESHOLD = 0.8

/** 解析后的行为文件结构 */
export interface BehaviorDoc {
  /** 原文件原始内容（写回时基于它做增量编辑，不重建） */
  raw: string
  /** 章节 → 条目行（保留行号语义，便于 diff 与替换） */
  sections: Map<string, SectionView>
  /** 被跳过（locked / 未知章节）的原始行，写回时原样保留 */
  skippedLines: string[]
}

/** 单个章节的视图：起始/结束行 + 内部条目列表 */
export interface SectionView {
  start: number
  end: number
  /** 条目内容（去掉 "* " 前缀与标签后的文本） */
  items: string[]
  /** 每个条目的原文行，与 items 一一对应（用于替换/定位） */
  lines: string[]
}

/**
 * 追加/替换条目后的结果，供指令回显 diff。
 */
export interface MergeResult {
  /** 操作类型：append = 新增；duplicate = 与已有条目相似度>0.8 被跳过 */
  action: 'append' | 'duplicate' | 'replaced'
  category: BehaviorCategory
  text: string
  targetLines: string[]
}

/** 备份快照信息（用于撤销） */
export interface BackupInfo {
  path: string
  timestamp: string
}

/**
 * 解析行为文件内容为章节视图。
 * 规则：
 * - 以 "## " 开头的行 = 章节标题；已知章节收集条目，未知章节归入 skipped。
 * - "<!--locked-->" 段落（含多行注释）一律跳过（不参与合并）。
 * - 条目行必须匹配 /^\* \[标签\] 内容/（标签优先取已知分类名，其次任意括号内容）。
 * - 章节的 end 定义为该章节在原文中的最后一行（下一个 "## " 标题的前一行，或文件末尾），
 *   供序列化时精确替换内容区。
 */
export function parseBehavior(raw: string): BehaviorDoc {
  const lines = raw.split('\n')
  const sections = new Map<string, SectionView>()
  for (const t of SECTION_TITLES) sections.set(t, { start: -1, end: -1, items: [], lines: [] })

  let current: string | null = null
  let locked = false
  const skippedLines: string[] = []
  let lastStart = -1
  let lastBodyEnd = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    // 遇到章节标题：先收尾上一个章节的内容区范围
    if (trimmed.startsWith('## ')) {
      if (current) {
        const view = sections.get(current)
        if (view) view.end = i - 1 < lastStart ? lastStart : i - 1
      }
      const title = trimmed.slice(3).trim()
      locked = false
      lastStart = i
      lastBodyEnd = -1
      current = SECTION_TITLES.includes(title) ? title : null
      const view = sections.get(title)
      if (view) view.start = i
      continue
    }

    // <!--locked--> 段落跳过（单行或多行）
    if (locked || trimmed.startsWith('<!--')) {
      if (trimmed.startsWith('<!--')) {
        locked = !trimmed.includes('-->')
      } else if (trimmed.includes('-->')) {
        locked = false
      }
      skippedLines.push(line)
      continue
    }

    if (!current || !sections.has(current)) {
      skippedLines.push(line)
      continue
    }

    if (lastBodyEnd < 0) lastBodyEnd = i
    // 章节内条目：* [标签] 内容
    const m = trimmed.match(/^\*\s*\[([^\]]+)\]\s*(.*)$/)
    if (!m) {
      skippedLines.push(line)
      continue
    }
    const label = m[1]!.trim()
    const text = m[2]!.trim()
    const sectionName = label as BehaviorCategory
    if (!BEHAVIOR_CATEGORIES.includes(sectionName)) {
      // 标签不在标准分类内：保留原文，不参与合并
      skippedLines.push(line)
      continue
    }
    const view = sections.get(current)!
    view.items.push(text)
    view.lines.push(line)
    lastBodyEnd = i
  }

  // 文件末尾：收尾最后一个章节
  if (current) {
    const view = sections.get(current)
    if (view) view.end = lastBodyEnd >= 0 ? lastBodyEnd : lastStart
  }

  return { raw, sections, skippedLines }
}

/** 确保行为文件存在；不存在时按约定新建章节 */
export async function ensureBehaviorFile(ctx: Context, logger: Logger): Promise<void> {
  const path = behaviorFilePath(ctx)
  await fs.mkdir(join(path, '..'), { recursive: true })
  try {
    await fs.access(path)
    const raw = await fs.readFile(path, 'utf8')
    // 已存在：校验至少有一个标准章节；若完全空白则补全章节
    const doc = parseBehavior(raw)
    const missing = BEHAVIOR_SECTIONS.filter((t) => doc.sections.get(t)!.start < 0)
    if (raw.trim() && missing.length) {
      logger.warn(`行为文件缺少章节 ${missing.join('、')}，将追加补建（原有内容保留）`)
      const append = missing.map((t) => `\n## ${t}\n`).join('')
      await fs.appendFile(path, append, 'utf8')
    } else if (!raw.trim()) {
      const text = `---\nlabel: 行为准则\ntitle: 行为准则\ndescription: 行为学习器自动维护的行为偏好（含用户确认的条目）\n---\n\n${BEHAVIOR_SECTIONS.map((t) => `## ${t}\n`).join('')}\n## 待确认\n\n`
      await fs.writeFile(path, text, 'utf8')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const text = `---\nlabel: 行为准则\ntitle: 行为准则\ndescription: 行为学习器自动维护的行为偏好（含用户确认的条目）\n---\n\n${BEHAVIOR_SECTIONS.map((t) => `## ${t}\n`).join('')}\n## 待确认\n\n`
    await fs.writeFile(path, text, 'utf8')
  }
}

/** 读取行为文件最新内容（每次写回前都必须重读重算 hash） */
export async function readBehavior(ctx: Context): Promise<string> {
  const path = behaviorFilePath(ctx)
  return fs.readFile(path, 'utf8')
}

/** 计算行为文件当前内容 hash（防外部修改检测的唯一依据） */
export async function hashBehavior(ctx: Context): Promise<string> {
  return hashContent(await readBehavior(ctx))
}

/**
 * 在指定章节追加或替换条目。
 * @param doc 解析后的文档（必须是最新解析，调用方负责重读）
 * @param category 目标章节
 * @param text 条目正文（不含 "* [标签] " 前缀）
 * @param replaceIdText 「改为」时的目标条目原文（匹配 items 中完全相同者则替换，否则转为追加）
 */
export function mergeIntoSection(
  doc: BehaviorDoc,
  category: BehaviorCategory,
  text: string,
  replaceIdText?: string,
): MergeResult {
  const view = doc.sections.get(category)!

  // 「改为：xxx」：在已有条目中精确定位要替换的那条
  if (replaceIdText && replaceIdText.trim()) {
    const idx = view.items.findIndex((it) => it.trim() === replaceIdText.trim())
    if (idx >= 0) {
      const label = `[${category}]`
      view.lines[idx] = `* ${label} ${text}`
      view.items[idx] = text
      return { action: 'replaced', category, text, targetLines: [view.lines[idx]!] }
    }
  }

  // 相似度去重：与同标签下任一已有条目相似 > 0.8 → 跳过
  for (const existing of view.items) {
    if (similarity(existing, text) > DEDUP_THRESHOLD) {
      return { action: 'duplicate', category, text, targetLines: [] }
    }
  }

  const line = `* [${category}] ${text}`
  view.items.push(text)
  view.lines.push(line)
  return { action: 'append', category, text, targetLines: [line] }
}

/** 在「改为」时用于定位旧文本的候选原文；返回其原始条目行 */
export function findOriginalLine(doc: BehaviorDoc, category: BehaviorCategory, text: string): string | undefined {
  const view = doc.sections.get(category)
  if (!view) return undefined
  const idx = view.items.findIndex((it) => it.trim() === text.trim())
  return idx >= 0 ? view.lines[idx] : undefined
}

/**
 * 把内存中的章节视图重建为完整文件内容（写回用）。
 *
 * 原则：流式输出。遇到标准章节标题时，用 view.lines（最新条目行）替换其内容区，
 * 跳过原内容区行；其余行（frontmatter、待确认章节、locked 段落、未知行）原样输出。
 */
export function serializeBehavior(doc: BehaviorDoc): string {
  const lines = doc.raw.split('\n')
  const output: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    // 标准章节标题：输出标题行 + 最新条目行，跳过原内容区
    if (trimmed.startsWith('## ') && BEHAVIOR_SECTIONS.includes(trimmed.slice(3).trim() as BehaviorCategory)) {
      output.push(line)
      const title = trimmed.slice(3).trim()
      const view = doc.sections.get(title)!
      const bodyStart = view.start + 1 // 标题后第一行
      const bodyEnd = Math.max(view.end, bodyStart - 1) // 原内容区最后一行
      // 输出最新条目行（可能为空章节）
      for (const itemLine of view.lines) output.push(itemLine)
      // 跳过原内容区
      i = bodyEnd + 1
      continue
    }
    output.push(line)
    i++
  }
  // 文件可能不以换行结尾，保持原样
  return output.join('\n')
}

/** 写回行为文件：备份 → 写入；调用方必须先重新 readBehavior + 重新 parse（hash 防线在调用方） */
export async function writeBehavior(ctx: Context, content: string, keep: number): Promise<BackupInfo> {
  const path = behaviorFilePath(ctx)
  // 1. 备份当前文件到 backups/（.md.bak 后缀，避开 core 扫描）
  const dir = backupsDir(ctx)
  await fs.mkdir(dir, { recursive: true })
  let current = ''
  try {
    current = await fs.readFile(path, 'utf8')
  } catch {
    /* 首次写入无旧文件 */
  }
  const backupName = `behavior.backup-${timestampForBackup()}.md.bak`
  const backupPath = join(dir, backupName)
  await fs.writeFile(backupPath, current, 'utf8')
  // 2. 写回
  await fs.writeFile(path, content, 'utf8')
  // 3. 环形清理：仅保留最近 keep 份
  const files = (await fs.readdir(dir)).filter((f) => /^behavior\.backup-\d+\.md\.bak$/.test(f)).sort()
  const excess = files.length - keep
  for (let i = 0; i < excess; i++) {
    await fs.unlink(join(dir, files[i]!)).catch(() => {})
  }
  return { path: backupPath, timestamp: timestampForBackup() }
}

/** 列出当前全部备份（撤销/回退用），按时间倒序 */
export async function listBackups(ctx: Context): Promise<BackupInfo[]> {
  const dir = backupsDir(ctx)
  try {
    const files = (await fs.readdir(dir)).filter((f) => /^behavior\.backup-\d+\.md\.bak$/.test(f)).sort()
    return files.map((f) => ({ path: join(dir, f), timestamp: f.replace(/^behavior\.backup-/, '').replace(/\.md\.bak$/, '') }))
  } catch {
    return []
  }
}

/** 从备份文件恢复内容（撤销用） */
export async function restoreFromBackup(path: string): Promise<string> {
  return fs.readFile(path, 'utf8')
}

/** 删除某个备份文件（撤销消费后删除） */
export async function deleteBackup(path: string): Promise<void> {
  await fs.unlink(path).catch(() => {})
}
