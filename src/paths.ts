import type { Context } from 'koishi'
import { join } from 'node:path'
import { Services } from 'koishi-plugin-yesimbot'

/**
 * 路径与能力守卫。
 *
 * 行为学习器涉及三类文件，路径刻意分开，避免污染 core 目录：
 * - behavior.md：写目标，位于 <baseDir>/data/yesimbot/memory/core/（会被 yesimbot 扫描注入）
 * - behavior.pending.json：候选暂存，位于 <baseDir>/data/yesimbot/memory/（【不在 core 目录】，
 *   避免未确认的候选被注入上下文 —— 定死约束，见表②修正）
 * - backups/：合并前备份，位于 <baseDir>/data/yesimbot/memory/backups/（【不在 core 目录】，
 *   备份文件带 .md.bak 后缀，避开 loadCoreMemoryBlocks 的 .md/.txt 扫描 —— 定死约束）
 */

/** 判断 yesimbot.world-state 服务是否已加载（可选注入，需运行时守卫） */
export function hasWorldState(ctx: Context): boolean {
  return !!ctx[Services.WorldState]
}

/** 判断 yesimbot.memory 服务是否已加载 */
export function hasMemory(ctx: Context): boolean {
  return !!ctx[Services.Memory]
}

/** 判断 yesimbot.model 服务是否已加载 */
export function hasModel(ctx: Context): boolean {
  return !!ctx[Services.Model]
}

/** 判断数据库服务是否已加载 */
export function hasDatabase(ctx: Context): boolean {
  return !!ctx.database
}

/** YesImBot 数据根目录：<koishi baseDir>/data/yesimbot */
export function yesimbotDataDir(ctx: Context): string {
  return join(ctx.baseDir, 'data', 'yesimbot')
}

/** 核心人格块目录（会被 yesimbot 扫描注入）：<baseDir>/data/yesimbot/memory/core */
export function coreMemoryDir(ctx: Context): string {
  return join(yesimbotDataDir(ctx), 'memory', 'core')
}

/** 行为文档（写目标）：core/behavior.md */
export function behaviorFilePath(ctx: Context): string {
  return join(coreMemoryDir(ctx), 'behavior.md')
}

/** 候选暂存文件（不注入）：memory/behavior.pending.json */
export function pendingFilePath(ctx: Context): string {
  return join(yesimbotDataDir(ctx), 'memory', 'behavior.pending.json')
}

/** 行为统计文件（不注入）：memory/behavior.stats.json */
export function statsFilePath(ctx: Context): string {
  return join(yesimbotDataDir(ctx), 'memory', 'behavior.stats.json')
}

/** 备份目录（不注入，.md.bak 后缀避开扫描）：memory/backups */
export function backupsDir(ctx: Context): string {
  return join(yesimbotDataDir(ctx), 'memory', 'backups')
}
