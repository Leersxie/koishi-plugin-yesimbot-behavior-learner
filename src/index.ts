/**
 * 插件入口。
 * koishi 会解包默认导出的插件对象（name / inject / Config / apply），
 * 同时保留命名导出，兼容 loader 的不同接入方式。
 */
import { Config, apply, inject, name } from './extension'

export default { name, inject, Config, apply }

export * from './extension'
export * from './config'
export * from './paths'
export * from './utils'
