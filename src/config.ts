import { Schema } from 'koishi'

/**
 * 插件配置项。
 * 所有字段均通过 Koishi Schema 声明，可在控制台可视化配置。
 */
export interface Config {
  // ===== 提炼与调度 =====
  /** 是否启用每日行为提炼（定时任务） */
  scheduleEnabled: boolean
  /** 每日触发时刻 HH:mm，默认 23:30 */
  scheduleTime: string
  /** 提炼采集的频道列表（格式 platform:channelId）；一期只在这些频道跑，空则不自动采集 */
  instructorChannel: string[]
  /** 提炼用的模型组（YesImBot 任务键，如 chat / summarize / memory） */
  mainModel: string
  /** 单频道当天最多取回的消息条数（避免超大频道刷爆预算；实际输入再按 token 预算裁切） */
  maxMessagesPerChannel: number
  /** 提炼输入 token 预算，默认 8000；优先保留最新、含纠正/别/不要/讨厌/夸关键词者 */
  tokenBudget: number
  /** 每轮最多候选条数，默认 3 */
  maxCandidates: number
  /** 候选保留时长（小时），默认 48；过期即删除（等价跳过） */
  candidateTtlHours: number

  // ===== 权限与推送 =====
  /** 指令白名单：仅这些 userId 可使用"行为"指令；留空时仅超级管理员(authority>=3)可用 */
  allowUserIds: string[]
  /** 私聊推送目标 userId 列表；支持两种格式：platform:userId 或纯 userId（找任意在线机器人） */
  notifyTarget: string[]

  // ===== 行为文件 =====
  /** 合并前备份保留份数（环形），默认 5，支持连续回滚 5 次 */
  backupKeep: number

  // ===== 其他 =====
  /** 开启后输出完整提示词与响应等调试日志；关闭时仅输出 warn/error */
  debug: boolean
}

/** Koishi Schema 定义 */
export const Config = Schema.object({
  scheduleEnabled: Schema.boolean().default(true).description('是否启用每日行为提炼（定时任务）'),
  scheduleTime: Schema.string()
    .pattern(/^\d{1,2}:\d{2}$/)
    .default('23:30')
    .description('每日触发时刻 HH:mm，默认 23:30'),
  instructorChannel: Schema.array(Schema.string())
    .default([])
    .description('提炼采集的频道列表（格式 platform:channelId）；一期只在这些频道跑，空则不自动采集'),
  mainModel: Schema.string()
    .default('chat')
    .description('提炼用的模型组（YesImBot 任务键，如 chat / summarize / memory）'),
  maxMessagesPerChannel: Schema.number()
    .min(1)
    .max(5000)
    .default(500)
    .description('单频道当天最多取回的消息条数（实际输入再按 token 预算裁切）'),
  tokenBudget: Schema.number()
    .min(1000)
    .max(64000)
    .default(8000)
    .description('提炼输入 token 预算；优先保留最新、含纠正/别/不要/讨厌/夸关键词者'),
  maxCandidates: Schema.number()
    .min(1)
    .max(10)
    .default(3)
    .description('每轮最多候选条数'),
  candidateTtlHours: Schema.number()
    .min(1)
    .max(720)
    .default(48)
    .description('候选保留时长（小时），过期即删除（等价跳过）'),
  allowUserIds: Schema.array(Schema.string())
    .default([])
    .description('指令白名单：仅这些 userId 可使用"行为"指令；留空时仅超级管理员可用'),
  notifyTarget: Schema.array(Schema.string())
    .default([])
    .description('私聊推送目标：platform:userId（按平台匹配机器人）或纯 userId（找任意在线机器人）'),
  backupKeep: Schema.number()
    .min(1)
    .max(20)
    .default(5)
    .description('合并前备份保留份数（环形），支持连续回滚'),
  debug: Schema.boolean().default(false).description('开启后输出完整提示词与响应等调试日志；关闭时仅输出 warn/error'),
})
