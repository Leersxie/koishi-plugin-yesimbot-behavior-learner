# koishi-plugin-yesimbot-behavior-learner

YesImBot 行为学习器：从日常对话中提炼「值得长期学习」的行为偏好 → 私聊推送候选 → 用户确认后写入行为文档。全程可控，**绝不自动修改 persona.md**。

> 说明：本插件由 AI 辅助编写（代码与文档均由 AI 生成，经人工实测验证后发布）。

## 功能

- **每日定时提炼**（默认 23:30）：从指定频道的当天对话中，用模型提炼行为偏好候选
- **私聊推送确认**：候选推送给你，逐条确认后才写入行为文档，绝不自动生效
- **完整指令闭环**：采纳 / 采纳并改内容 / 跳过 / 全跳过 / 查看 / 撤销
- **安全写入**：合并前自动备份（`memory/backups/`，环形保留 5 份）、外部手动修改检测（内容 hash，不碰 mtime）、相似度去重（>0.8 跳过）
- **不污染记忆**：候选暂存在独立文件 `behavior.pending.json`（不在 `core/` 目录），backups 用 `.md.bak` 后缀，均不会被 YesImBot 自动加载注入

## 工作原理

```
定时触发(23:30) → 按日查询消息 → 空则静默跳过 → token 截断(8K)
→ 模型提炼 JSON（只输出 JSON、证据引原文含时间、禁编造、禁一次性玩笑）
→ 候选写入独立 pending 文件（不注入 core）
→ 私聊推送确认 → 采纳：写入 behavior.md 对应章节 + 从 pending 移除
→ 跳过：从 pending 移除 → 备份放 backups/ 目录，不污染 core
```

## 安装

```sh
npm i koishi-plugin-yesimbot-behavior-learner
# 或直接在 Koishi 控制台的「插件市场」中搜索安装
```

依赖：

- `koishi` ^4.18.7（Koishi v4.18+）
- `koishi-plugin-yesimbot` ^3.0.3（YesImBot 本体，需提前安装运行）

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `scheduleEnabled` | `true` | 是否启用每日定时提炼 |
| `scheduleTime` | `23:30` | 每日提炼时刻 |
| `instructorChannel` | `[]` | 提炼来源频道（`platform:channelId`，多频道） |
| `mainModel` | `chat` | 使用的模型任务名（对应 YesImBot `model` 配置里的 `task` 名，如 `chat`） |
| `maxMessagesPerChannel` | `500` | 每频道最多采集消息数 |
| `tokenBudget` | `8000` | 提炼素材 token 预算（优先保留最新 + 含「纠正/别/不要/讨厌/夸」关键词的消息） |
| `maxCandidates` | `3` | 每轮最多提炼候选数 |
| `candidateTtlHours` | `48` | 候选有效期（过期自动跳过） |
| `allowUserIds` | `[]` | 指令白名单；留空则仅超级管理员（authority>=3） |
| `notifyTarget` | `[]` | 私聊推送目标（`platform:userId`） |
| `backupKeep` | `5` | 备份环形保留份数 |
| `debug` | `false` | 调试日志 |

## 指令

| 指令 | 说明 |
| --- | --- |
| `行为 立即` | 手动触发一轮提炼（与定时同一逻辑，便于调试） |
| `行为 查看` | 查看待确认候选 |
| `行为 采纳 <ID>` | 采纳候选，写入行为文档 |
| `行为 采纳 <ID> 改为：xxx` | 采纳但使用修改后的内容 |
| `行为 跳过 <ID>` | 跳过该候选 |
| `行为 全跳过` | 跳过全部候选 |
| `行为 撤销` | 回滚最近一次合并（候选重新回到待确认，可再次采纳） |

## 数据文件

- `data/yesimbot/memory/core/behavior.md`：最终行为文档（标签 `label: 行为准则`），含章节：说话风格 / 表达偏好 / 禁忌与回避
- `data/yesimbot/memory/behavior.pending.json`：待确认候选（独立文件，不注入模型上下文）
- `data/yesimbot/memory/backups/behavior.backup-<时间戳>.md.bak`：合并前备份（环形保留 `backupKeep` 份）

## 行为文档条目格式

```markdown
* [说话风格] 内容描述
```

合并规则：同标签下与已有条目相似度 > 0.8 则跳过（不重复写入）；`<!--locked-->` 段落跳过不处理。

## 免责声明

本项目代码与文档由 AI 生成，并已通过编译与线上实测验证。使用时请留意：模型提炼结果可能存在误判，所有候选均需人工确认后才会写入行为文档。
