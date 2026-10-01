import type { Context, Logger } from 'koishi'
import { Config } from './config'
import { ensureBehaviorFile } from './services/behavior-file'
import { CommandHandler, isUserAllowed } from './services/command-handler'
import { BehaviorScheduler } from './services/scheduler'

/**
 * 插件主逻辑（普通 koishi 插件形态：name / inject / Config / apply）。
 *
 * 职责：
 * 1. 启动时确保 behavior.md 存在（按约定章节新建，不动 persona.md）；
 * 2. 注册「行为」指令组（CommandHandler）；
 * 3. 每日定时提炼（BehaviorScheduler，setTimeout 递归；卸载时 dispose）。
 *
 * 依赖注入：database / yesimbot.model / yesimbot.world-state / yesimbot.memory
 * 全部可选（运行时守卫 has* 判断），缺任意能力时按降级逻辑运行：
 * - 无 database → 当天消息采集跳过（静默）；无 model → 提炼失败仅日志；
 * - 指令与文件读写（behavior.md / pending / backups）不依赖任何服务。
 */

export const name = 'yesimbot-behavior-learner'

/** 服务均为可选注入：运行时按能力守卫降级，不因缺服务而崩 */
export const inject = {
  required: [],
  optional: ['database', 'yesimbot.model', 'yesimbot.world-state', 'yesimbot.memory'],
}

export { Config }

export function apply(ctx: Context, config: Config) {
  const logger: Logger = ctx.logger('yesimbot-behavior-learner')

  // 启动时确保行为文件存在（幂等；缺 label 等异常在 ensureBehaviorFile 内处理）
  ctx.on('ready', () => {
    void ensureBehaviorFile(ctx, logger).catch((error) => {
      logger.warn(`[启动] 行为文件初始化失败：${(error as Error).message}`)
    })
  })

  // 指令组
  const commands = new CommandHandler(ctx, config, logger)
  void commands

  // 每日定时提炼
  const scheduler = new BehaviorScheduler(ctx, config, logger)
  ctx.on('ready', () => scheduler.start())
  ctx.on('dispose', () => scheduler.dispose())

  // 手动触发一轮提炼（调试/验收用，白名单外不可用）
  ctx
    .command('行为.立即', '手动触发一次行为提炼（与定时同一逻辑，调试用）')
    .action(async ({ session }) => {
      if (!isUserAllowed(config, session)) return '你没有权限使用「行为」指令'
      if (!session) return '没有可用的会话上下文'
      await session.send('正在手动触发本轮行为提炼…')
      const result = await scheduler.runNow()
      return result
    })
}
