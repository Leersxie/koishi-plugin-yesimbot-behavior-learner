import type { Context, Logger } from 'koishi'
import { Services, TaskType, type ChatModelSwitcher, type ModelService } from 'koishi-plugin-yesimbot'
import type { Config } from '../config'
import { hasModel } from '../paths'
import type { FlatMessage, formatMaterials } from './message-collector'
import { parseJsonLoose } from '../utils'

/**
 * 行为提炼（模型调用 + 结果解析）。
 *
 * 【prompt 硬约束】：
 * - 只输出 JSON；
 * - 证据必须引当天原文（含时间），无证据丢弃；
 * - 禁止编造；禁止把一次性玩笑当长期偏好；
 * - confidence >= 0.8 标「建议采纳」，低于标「建议确认」；一期全走确认；
 * - 每轮最多 maxCandidates 条。
 *
 * 解析失败或结构不合法 → 丢弃该条/整轮结果，绝不自动写入。
 */

/** 模型返回的单条候选（模型产出, 未经校验） */
export interface ModelCandidate {
  category?: string
  content?: string
  text?: string
  evidence?: string
  time?: string
  confidence?: string | number
}

/** 模型返回整体结构（宽松） */
export interface ModelPayload {
  candidates?: ModelCandidate[]
  candidate?: ModelCandidate | ModelCandidate[]
}

/** 失败类型（供上层决定是否重试 / 放弃） */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

/**
 * 通过 YesImBot ModelService 解析模型组。
 *
 * 注意：useChatGroup 只接受【任务名】（config.task[name]），传入组名会打
 * 「切换器 ⚠ 无效的任务名称」警告并返回 undefined。这里先探测配置里的任务表：
 * mainModel 若配置为存在的任务名（如 'chat'）则精确命中；否则回落默认对话任务
 * TaskType.Chat，避免无谓的 warn 日志（与 livingdiary 相同的解析目标）。
 */
export function resolveModel(ctx: Context, group: string): ChatModelSwitcher | null {
  try {
    const service: ModelService | undefined = ctx[Services.Model]
    if (!service?.useChatGroup) return null
    const task = (service.config as { task?: Record<string, string> } | undefined)?.task
    const name = task && task[group] ? group : TaskType.Chat
    return service.useChatGroup(name) ?? null
  } catch {
    return null
  }
}

/** 构建提炼 prompt：只输出 JSON，证据引原文+时间，禁止编造 */
export function buildPrompt(materials: string, maxCandidates: number): string {
  return [
    '你是行为偏好提炼器。从下方【当天对话素材】中，提炼用户对机器人风格的偏好，输出 JSON。',
    '要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字或解释；',
    '2. 只提炼「值得长期学习」的偏好：说话风格、表达偏好、禁忌与回避；',
    '3. 每条候选必须附证据：evidence 字段引用当天原文（原文摘录，禁止改写），time 字段为消息时间（HH:mm，必须来自素材原文）；',
    '4. 无证据支撑的判断直接丢弃；禁止编造素材中不存在的内容；',
    '5. 禁止把一次性玩笑、临时调侃当作长期偏好（仅当明确且重复出现才提炼）；',
    '6. confidence 为 0~1 数字：>=0.8 表示建议采纳，否则表示建议确认；',
    '7. 建议每轮最多 ' + String(maxCandidates) + ' 条，宁缺毋滥；',
    '8. JSON 结构：{ "candidates": [ { "category": "说话风格|表达偏好|禁忌与回避", "content": "条目内容", "evidence": "原文", "time": "HH:mm", "confidence": 0.9 } ] }',
    '',
    '【当天对话素材】',
    materials,
    '',
    'JSON：',
  ].join('\n')
}

/** 调用模型生成候选（单次，超时容错由上层的 scheduler 处理） */
export async function extractCandidates(
  ctx: Context,
  config: Config,
  materials: string,
  logger: Logger,
): Promise<ModelCandidate[]> {
  const model = resolveModel(ctx, config.mainModel)
  if (!model) {
    throw new ExtractionError(`模型不可用：请检查 mainModel 配置（${config.mainModel}）`)
  }
  const prompt = buildPrompt(materials, config.maxCandidates)
  if (config.debug) logger.debug(`[提炼提示词]\n${prompt}`)
  const res = await model.chat({
    messages: [{ role: 'user', content: prompt }],
    // 提炼偏好：较低温度保证稳定格式
    temperature: 0.3,
  } as never)
  const text = (res?.text ?? '').trim()
  if (!text) throw new ExtractionError('模型输出为空')
  if (config.debug) logger.debug(`[提炼响应]\n${text}`)
  return parsePayload(text)
}

/** 校验并以稳定结构返回候选；单条无证据/分类非法直接丢弃 */
export function parsePayload(raw: string): ModelCandidate[] {
  let body: ModelPayload
  try {
    body = parseJsonLoose(raw) as ModelPayload
  } catch (error) {
    throw new ExtractionError((error as Error).message)
  }
  const rawList: ModelCandidate[] = []
  if (Array.isArray(body.candidates)) rawList.push(...body.candidates)
  else if (Array.isArray(body.candidate)) rawList.push(...body.candidate)
  else if (body.candidate && typeof body.candidate === 'object') rawList.push(body.candidate)

  const list: ModelCandidate[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const content = (item.content ?? item.text ?? '').toString().trim()
    const evidence = (item.evidence ?? '').toString().trim()
    const category = (item.category ?? '').toString().trim()
    const time = (item.time ?? '').toString().trim()
    // 硬约束：无内容 / 无证据（证据必须引用原文）→ 丢弃
    if (!content || !evidence) continue
    // 分类必须合法
    if (!['说话风格', '表达偏好', '禁忌与回避'].includes(category)) continue
    // time 可为空（素材中找不到明确时刻时）；不为空则校验 HH:mm 形状
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) continue
    let confidence = 0.5
    if (typeof item.confidence === 'number') confidence = item.confidence
    else {
      const parsed = Number.parseFloat(String(item.confidence))
      if (Number.isFinite(parsed)) confidence = parsed
    }
    confidence = Math.max(0, Math.min(1, confidence))
    list.push({ category, content, evidence, time, confidence })
  }
  return list
}

/** 把 ModelCandidate 归一化（供上层拼接增强字段） */
export function normalizeEvidence(item: ModelCandidate, messages: FlatMessage[]): { evidence: string; time: string } {
  // 若模型给的时间在素材中不存在，回退为最早相关消息；简化：使用素材中与证据最相似者
  let evidence = (item.evidence ?? '').trim()
  let time = (item.time ?? '').trim()
  const match = messages.find(
    (m) => m.content.includes(evidence) || evidence.includes(m.content.slice(0, 12)) || m.time === time,
  )
  if (match && (!time || !/^\d{1,2}:\d{2}$/.test(time) || match.time === time)) {
    time = match.time
  }
  if (!time) {
    const fallback = messages.find((m) => m.content.includes(evidence.slice(0, 6)))
    if (fallback) time = fallback.time
  }
  return { evidence, time }
}
