/**
 * dsh-selection-annotations — 宿主半边（Node / Cordis）。
 *
 * 职责只有一件事：让「批注数据块」以**独立的一条消息**进入模型请求。
 *
 * 客户端半边把批注集合包成一份 JSON 附件随用户消息提交，于是那条用户消息的 content
 * 形如 `[{type:'text'}, {type:'file'}]` —— 正文与批注块本来就是两个独立 content 块。
 *
 * 但 `file` 块进入模型时只会被投影成一行路径句柄（`dsh-llm` 的 `fileHandleText`），模型
 * 得自己 `read` 一次才看得到内容。所以这里在 `agent/pre-step`（官方 waterfall seam，
 * `dsh-session-reference` 的 recall 用的就是它）做两步：
 *
 *   1. 把该 `file` 块从**发给模型**的消息里摘掉（持久化日志不变，UI 仍显示附件卡片）；
 *   2. 紧随其后追加一条独立的 user 消息，正文就是批注 JSON 本身。
 *
 * 结果：模型看到的是「用户正文」+「一条独立的 JSON 批注消息」，两者互不混杂。
 *
 * 认领依据是**内容**而不是文件名：读出来的 JSON 必须带 `kind: 'dsh-selection-annotations'`。
 * 文件名只用于快速预筛，`name` 变了也能正常工作。
 *
 * 本文件刻意不 import 任何 `@deepseek-ai/*` 包：请求期消息只需要 role/content/source，
 * 自带等价实现即可，避免跨版本包解析问题。
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** 客户端给批注负载起的文件名 —— 只是预筛，不参与认领判定。 */
const ANNOTATION_FILE = '批注.json'

/** 与客户端半边共用的负载类型标记（写进 JSON 的 `kind` 字段）。 */
const PAYLOAD_KIND = 'dsh-selection-annotations'

/** 单个附件读取上限的默认值，避免异常大文件拖垮这一步。 */
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024

export const name = 'selection-annotations'

// 这里刻意**不**声明 `export const Config`：schema 需要 `@deepseek-ai/schemastery`，
// 而本插件是以 `link:` 装进 profile 的 —— 模块解析按插件的真实路径（工作区）进行，
// 工作区没有 node_modules，`@deepseek-ai/*` 一律解析不到，静态导入会让整个宿主半边
// 加载失败（fiberPhase 停在 null，功能静默消失）。
// `apply(ctx, config)` 仍然照常收到 entry 的 config，所以需要在 profile patch 里写
// `config: { maxPayloadBytes: … }` 依然生效，只是没有可投影的 JSON Schema。

/** 不声明 inject：缺少附件服务时本插件仍应加载，只是退化为不做任何改写。 */
export function apply(ctx, config) {
  const maxPayloadBytes = normalizeMaxBytes(config?.maxPayloadBytes)

  ctx.on(
    'agent/pre-step',
    async ({ signal }, next) => {
      const decision = await next()
      if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
      if (!Array.isArray(decision.messages)) return decision

      const messages = []
      let changed = false

      for (const message of decision.messages) {
        const content = Array.isArray(message?.content) ? message.content : []
        const candidates = content.filter(isAnnotationBlock)

        // 只处理用户自己提交的消息；我们追加的批注消息 source.kind 是 'annotation'，不会被再次处理。
        if (candidates.length === 0 || message?.source?.kind !== 'user') {
          messages.push(message)
          continue
        }

        const { claimed, payloads } = await collectAnnotationBlocks(ctx, candidates, signal, maxPayloadBytes)
        if (claimed.length === 0) {
          messages.push(message)
          continue
        }

        const kept = content.filter((block) => !claimed.includes(block))
        changed = true

        // 正文块保留（通常只有 text）；只剩批注块时整条丢弃，避免产生空消息。
        if (kept.length > 0) messages.push({ ...message, content: kept })

        const payload = mergePayloads(payloads)
        if (payload !== undefined) {
          messages.push({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            source: { kind: 'annotation', version: 1, count: payload.annotations.length },
          })
        }
      }

      return changed ? { ...decision, messages } : decision
    },
    { prepend: true },
  )
}

/**
 * 该 content 块是不是候选批注负载。
 * 只做便宜的预筛（类型 + 文件名后缀），真正的认领在 {@link parsePayload} 里按内容判定。
 */
function isAnnotationBlock(block) {
  if (block === null || typeof block !== 'object' || block.type !== 'file') return false
  const attachment = block.attachment
  if (attachment === null || typeof attachment !== 'object') return false
  if (typeof attachment.name !== 'string') return false
  return attachment.name === ANNOTATION_FILE || attachment.name.toLowerCase().endsWith('.json')
}

/**
 * 逐个读取候选附件，只认领内容确实是本插件负载的那些。
 * 任何读取或解析失败都降级为「不认领」，绝不中断这一轮。
 * @returns 认领的块（按原顺序）与解析出来的负载。
 */
async function collectAnnotationBlocks(ctx, blocks, signal, maxPayloadBytes) {
  const claimed = []
  const payloads = []
  for (const block of blocks) {
    if (signal?.aborted === true) break
    const text = await readAttachmentText(ctx, block.attachment, maxPayloadBytes)
    const payload = parsePayload(text)
    if (payload === undefined) continue
    claimed.push(block)
    payloads.push(payload)
  }
  return { claimed, payloads }
}

/** 认领的唯一依据：能解析成对象、`kind` 对得上、`annotations` 是数组。 */
function parsePayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (parsed.kind !== PAYLOAD_KIND) return undefined
  if (!Array.isArray(parsed.annotations)) return undefined
  return parsed
}

/**
 * 合并多份负载为一份数据块，并把 `index` 重新编号成 1..N。
 * 单份时原样返回，保留客户端写好的 `instruction` 等字段。
 */
function mergePayloads(payloads) {
  if (payloads.length === 0) return undefined
  if (payloads.length === 1) return payloads[0]
  const annotations = payloads
    .flatMap((payload) => payload.annotations)
    .map((item, index) => ({ ...item, index: index + 1 }))
  return { ...payloads[0], count: annotations.length, annotations }
}

/** 配置兜底：非法值回落到默认上限，而不是让这一步失败。 */
function normalizeMaxBytes(value) {
  return Number.isSafeInteger(value) && value >= 1024 ? value : DEFAULT_MAX_PAYLOAD_BYTES
}

/** 优先走附件服务的流式读取，退化到宿主路径直接读文件。 */
async function readAttachmentText(ctx, ref, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  let attachments
  try {
    attachments = ctx.get('attachments')
  } catch {
    attachments = undefined
  }
  if (attachments === undefined || attachments === null) return undefined

  if (typeof attachments.readFileStream === 'function') {
    try {
      const chunks = []
      let total = 0
      for await (const chunk of attachments.readFileStream(ref)) {
        const bytes = Buffer.from(chunk)
        // 超限视为无效负载（不认领），而不是截断半份数据丢给模型。
        if (total + bytes.length > maxPayloadBytes) return undefined
        total += bytes.length
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString('utf8')
    } catch {
      /* 落到宿主路径读取 */
    }
  }

  if (typeof attachments.fileHostPath === 'function') {
    try {
      return await readFile(attachments.fileHostPath(ref), 'utf8')
    } catch {
      return undefined
    }
  }

  return undefined
}
