/**
 * @u2a5f/dsh-selection-annotations — 客户端半边（Web bundle）。
 *
 * 设计要点（用户明确要求）：
 *   - 批注 **不写进消息正文**。既不拼草稿、也不做「发出去再从气泡里藏掉」的手术。
 *   - 批注以**原生附件块**（`file` content part）随消息提交：把批注报告包成一个 `File`，
 *     交给运行时自己的 `createDrafts` + 输入外壳的 `addFiles`（拖拽/粘贴附件走的就是这条
 *     链路）。于是那条用户消息的 content 天然是 `[{type:'text'}, {type:'file'}]` 两个独立块，DSH 官方 UI 就把它们
 *     分开渲染（正文气泡 + 附件卡片），宿主半边再把附件块换成一条独立的批注消息发给模型。
 *
 * 另一半职责是「选中即批注」本身：选区 → 浮动工具条 → 批注弹层 → 原文高亮 + 编号角标，
 * 锚点只用语义化 `data-*`（`data-chat-anchor-key` / `data-chat-flow-kind` /
 * `data-textpreview-url` / `data-textpreview-line`），不依赖 CSS Modules 哈希类名。
 */
window.__ModuleLoader__.load({
  id: '@u2a5f/dsh-selection-annotations',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 批注负载的文件名；只是给用户看的，宿主靠 JSON 里的 kind 字段认领。 */
    const ANNOTATION_FILE = '批注.json'
    /** 负载类型标记；客户端与宿主半边共用这个值。 */
    const PAYLOAD_KIND = 'dsh-selection-annotations'
    const MAX_QUOTE = 1600
    const MAX_NOTE = 4000
    /** 选区稳定后再弹工具条，避免拖选过程中抖动。 */
    const SETTLE_MS = 220
    /** 批注集合变化后合并上传，避免每敲一个字都发一次请求。 */
    const UPLOAD_DEBOUNCE_MS = 450
    /** 等草稿附件上传就绪的上限；超时就本次不挂，绝不制造发送失败。 */
    const UPLOAD_READY_TIMEOUT_MS = 10000
    /** 装饰重绘合并窗口。 */
    const REPAINT_MS = 120

    const CSS = `
.sa-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.sa-hl { position: fixed; pointer-events: none; border-radius: 3px;
  background: rgb(255 208 66 / 0.45); box-shadow: inset 0 -1px 0 rgb(255 176 0 / 0.75); }
.sa-badge { position: fixed; pointer-events: auto; cursor: pointer; font: inherit; border: none; padding: 0 3px; min-width: 15px; height: 15px; padding: 0 3px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 8px;
  background: var(--dsw-alias-brand-primary, #247bbf); color: #fff; font-size: 10px; line-height: 1;
  font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-toolbar { position: fixed; display: none; z-index: 61; }
.sa-toolbar[data-open="1"] { display: block; }
.sa-btn { font: inherit; font-size: 12px; line-height: 1; padding: 6px 10px; cursor: pointer;
  color: var(--dsw-alias-label-primary, CanvasText); background: var(--dsw-alias-bg-overlay, Canvas);
  border: 1px solid var(--dsw-alias-border-l2, ButtonBorder); border-radius: 7px;
  box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.sa-btn:hover { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }
.sa-popover { position: fixed; display: none; z-index: 62; width: 340px; max-width: calc(100vw - 24px);
  padding: 10px; box-sizing: border-box; border-radius: 10px; color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-overlay, Canvas); border: 1px solid var(--dsw-alias-border-l2, ButtonBorder);
  box-shadow: 0 10px 32px rgba(0,0,0,.24); }
.sa-popover[data-open="1"] { display: block; }
.sa-pop-title { font-size: 12px; font-weight: 600; margin: 0 0 6px; }
.sa-pop-quote { max-height: 120px; overflow: auto; margin: 0 0 8px; padding: 6px 8px; font-size: 12px;
  white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, GrayText);
  background: var(--dsw-alias-bg-layer-2, ButtonFace); border-left: 2px solid var(--dsw-alias-border-l2, ButtonBorder); border-radius: 4px; }
.sa-pop-src { margin: 0 0 8px; font-size: 11px; color: var(--dsw-alias-label-secondary, GrayText); }
.sa-pop-input { width: 100%; box-sizing: border-box; min-height: 62px; resize: vertical; padding: 6px 8px;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary, CanvasText); background: var(--dsw-alias-bg-layer-1, Canvas);
  border: 1px solid var(--dsw-alias-border-l1, ButtonBorder); border-radius: 6px; }
.sa-pop-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.sa-pop-spacer { flex: 1; }
.sa-pop-delete { color: var(--dsw-alias-state-error-primary, #e5484d); }
.sa-float { position: fixed; z-index: 63; max-width: calc(100vw - 16px); }
.sa-chip { font: inherit; font-size: 12px; line-height: 1; padding: 5px 9px; cursor: pointer;
  color: var(--dsw-alias-brand-primary, #247bbf); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 38%, transparent); border-radius: 999px; }
.sa-chip:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 22%, transparent); }
.sa-chip-open { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 30%, transparent); }
.sa-panel { width: min(520px, calc(100vw - 32px)); max-height: 320px; overflow: auto; padding: 8px;
  box-sizing: border-box; border-radius: 10px; color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-layer-1, Canvas); border: 1px solid var(--dsw-alias-border-l2, ButtonBorder); }
.sa-item { padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, ButtonBorder); }
.sa-item:last-child { border-bottom: none; }
.sa-item-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary, GrayText); }
.sa-item-num { font-weight: 600; color: var(--dsw-alias-brand-primary, #247bbf); }
.sa-item-src { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-item-quote { margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary, CanvasText); }
.sa-item-note { margin: 2px 0 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, GrayText); }
.sa-link { font: inherit; font-size: 11px; padding: 2px 4px; cursor: pointer; background: none; border: none;
  color: var(--dsw-alias-label-secondary, GrayText); text-decoration: underline; }
.sa-link:hover { color: var(--dsw-alias-state-error-primary, #e5484d); }
.sa-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.sa-search { flex: 1; box-sizing: border-box; padding: 5px 8px; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary, CanvasText); background: var(--dsw-alias-bg-layer-2, ButtonFace);
  border: 1px solid var(--dsw-alias-border-l1, ButtonBorder); border-radius: 6px; }
.sa-result { display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; padding: 5px 6px;
  cursor: pointer; background: none; border: none; border-radius: 6px; color: var(--dsw-alias-label-primary, CanvasText); }
.sa-result:hover { background: var(--dsw-alias-bg-layer-2, ButtonFace); }
.sa-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, GrayText); }
`

    return {
      name: '@u2a5f/dsh-selection-annotations',
      inject: ['slots', 'sessions', 'conversation'],
      apply(ctx) {
        /* ------------------------------------------------------------------ 状态 */

        /** 当前会话的批注集合；编号与顺序就是发给模型时的编号。 */
        let annotations = []
        /** 当前挂在草稿上的批注附件 receipt；发送后被 composer 消费。 */
        let draftIds = []
        let syncing = false
        let syncTimer = null
        let repaintTimer = null
        let settleTimer = null
        let pendingSelection = null
        /** 由槽位标准 props 注入的 composer 动作与当前会话 id —— 比自行解析 scope 更稳。 */
        let latestInputActions = undefined
        let latestSessionId = undefined
        /** 批注集合归属的会话；切换会话即清空，避免批注跑到别的会话里。 */
        let annotationsSession = undefined
        /** 批注附件是否已被 composer 确认挂上（用来区分「还没同步」与「已被发送消费」）。 */
        let draftSeen = false
        /** 本插件正在自己摘/挂附件时为真：这段发布不能被当成「消息已发送」。 */
        let maintaining = false
        let watchUnsub = undefined

        const listeners = new Set()
        const subscribe = (fn) => {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        }
        const snapshot = () => annotations
        function emit() {
          for (const fn of [...listeners]) {
            try {
              fn()
            } catch (err) {
              console.warn('[selection-annotations] 订阅回调失败：', err)
            }
          }
        }

        /* ------------------------------------------------------------------ 基础工具 */

        const safe = (fn) => {
          try {
            return fn()
          } catch {
            return undefined
          }
        }

        function elementOf(node) {
          if (node === null || node === undefined) return null
          if (node.nodeType === 1) return node
          return node.parentElement ?? null
        }

        /** 当前会话 id：优先槽位 props，其次 uiSession 的 current 绑定，最后退回会话列表。 */
        function currentSessionId() {
          if (typeof latestSessionId === 'string' && latestSessionId !== '') return latestSessionId
          const fromUi = safe(() => {
            const binding = ctx.get('uiSession')?.adapter?.current?.getSnapshot?.()
            return typeof binding?.key === 'string' && binding.key !== '' ? binding.key : undefined
          })
          if (fromUi !== undefined) return fromUi
          return safe(() => {
            const snap = ctx.sessions?.list?.getSnapshot?.()
            if (snap === undefined || snap === null) return undefined
            if (typeof snap.current === 'string' && snap.current !== '') return snap.current
            const ids = Array.isArray(snap.ids) ? snap.ids : Object.keys(snap.byId ?? {})
            for (const id of ids) {
              const retained = snap.byId?.[id]?.retainedBy
              if (retained !== null && typeof retained === 'object' && retained.mainView > 0) return id
            }
            return undefined
          })
        }

        /** 当前会话的 composer 输入外壳；拿不到就静默降级（批注仍可记录，只是不随消息发送）。 */
        function inputShell() {
          const sessionId = currentSessionId()
          if (sessionId === undefined) return undefined
          return safe(() => {
            const scoped = ctx.sessions.scope(sessionId)
            if (scoped === undefined || scoped === null) return undefined
            return ctx.conversation.input.for(scoped)
          })
        }

        /**
         * 盯着 composer 的输入态：批注附件一旦确认挂上又被消费（消息发出）或被用户摘掉，
         * 就把这批批注视为已送达并清空，避免它继续黏在下一条消息上。
         */
        function watchDraft() {
          if (watchUnsub !== undefined) return
          const shell = inputShell()
          const state = shell?.state
          if (state === undefined || typeof state.subscribe !== 'function' || typeof state.getSnapshot !== 'function') return
          const onChange = () => {
            if (maintaining) return
            if (draftIds.length === 0) return
            const snapshot = safe(() => state.getSnapshot())
            if (snapshot === undefined || snapshot === null) return
            const ids = Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds : []
            const present = draftIds.some((id) => ids.includes(id))
            if (present) {
              draftSeen = true
              return
            }
            if (!draftSeen) return
            draftIds = []
            draftSeen = false
            if (annotations.length > 0) {
              annotations = []
              emit()
              scheduleRepaint()
            }
          }
          watchUnsub = state.subscribe(onChange)
        }

        /** 会话切换：清空上一会话的批注与附件。 */
        function adoptSession(sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return
          if (annotationsSession === undefined) {
            annotationsSession = sessionId
            return
          }
          if (annotationsSession === sessionId) return
          annotationsSession = sessionId
          annotations = []
          draftIds = []
          draftSeen = false
          emit()
          scheduleRepaint()
        }

        function toBase64(bytes) {
          let binary = ''
          const step = 0x8000
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
          }
          return btoa(binary)
        }

        /* ------------------------------------------------------------------ 锚点 */

        /**
         * 选区在根元素内的字符区间（半开 `[start, end)`，与 `textContent` 口径一致）。
         * 这是批注位置的可校验表示：引文可能重复，字符区间不会。
         */
        function offsetRange(root, range) {
          const measure = (node, offset) =>
            safe(() => {
              const probe = range.cloneRange()
              probe.setStart(root, 0)
              probe.setEnd(node, offset)
              return probe.toString().length
            })
          const start = measure(range.startContainer, range.startOffset)
          const end = measure(range.endContainer, range.endOffset)
          if (start === undefined) return { start: undefined, end: undefined }
          return { start, end: end === undefined || end < start ? start : end }
        }

        function pathFromPreviewUrl(url) {
          // dsh-resource://file/session/<sessionId>/<encoded path>
          const marker = '/session/'
          const at = url.indexOf(marker)
          if (at === -1) return undefined
          const rest = url.slice(at + marker.length)
          const slash = rest.indexOf('/')
          if (slash === -1) return undefined
          const raw = rest.slice(slash + 1)
          return safe(() => decodeURIComponent(raw)) ?? raw
        }

        function lineNumberOf(element) {
          if (element === null) return undefined
          const holder = element.closest('[data-textpreview-line]')
          if (holder === null) return undefined
          const value = Number(holder.getAttribute('data-textpreview-line'))
          return Number.isFinite(value) ? value : undefined
        }

        /**
         * 代码预览没有行号属性，只能按 `.line` 的序号推算。
         * 先看选区端点能不能向上找到最近的 `.line`；找不到再退回「第几个 .line 包含它」。
         */
        function codeLineNumberOf(scope, element) {
          if (element === null || scope === null || scope === undefined) return undefined
          const lines = [...scope.querySelectorAll('.line')]
          const own = typeof element.closest === 'function' ? element.closest('.line') : null
          const target = own !== null ? own : lines.find((line) => line.contains(element))
          if (target === null || target === undefined) return undefined
          const index = lines.indexOf(target)
          return index === -1 ? undefined : index + 1
        }

        /**
         * 行号区间：优先用行自带的 `data-textpreview-line`（纯文本预览有）；
         * 代码预览没有这个属性，退回按 `.line` 序号推算。两者都拿不到就不写行号。
         */
        function lineRangeWithin(root, startEl, endEl) {
          const marked = lineNumberOf(startEl) ?? lineNumberOf(endEl)
          if (marked !== undefined) return { start: marked, end: lineNumberOf(endEl) ?? marked }
          const start = codeLineNumberOf(root, startEl)
          if (start === undefined) return { start: undefined, end: undefined }
          return { start, end: codeLineNumberOf(root, endEl) ?? start }
        }

        /**
         * 记录选区来源：哪条消息 / 哪个文件 / 行号区间 / 字符区间。
         * 字符区间是 `[charStart, charEnd)`，以锚点根元素的 `textContent` 为口径。
         */
        function captureSource(range) {
          const startEl = elementOf(range.startContainer)
          const endEl = elementOf(range.endContainer)
          if (startEl === null) return { kind: 'dom' }

          const row = startEl.closest('[data-chat-anchor-key]')
          if (row !== null) {
            const chars = offsetRange(row, range)
            return {
              kind: 'message',
              role: (row.getAttribute('data-chat-flow-kind') ?? '') === 'user' ? 'user' : 'assistant',
              anchorKey: row.getAttribute('data-chat-anchor-key') ?? '',
              flowKind: row.getAttribute('data-chat-flow-kind') ?? '',
              charStart: chars.start,
              charEnd: chars.end,
            }
          }

          const doc = startEl.closest('[data-textpreview-url]')
          if (doc !== null) {
            const url = doc.getAttribute('data-textpreview-url') ?? ''
            const lines = lineRangeWithin(doc, startEl, endEl)
            const chars = offsetRange(doc, range)
            return {
              kind: 'file',
              path: pathFromPreviewUrl(url),
              sourceUrl: url,
              lineStart: lines.start,
              lineEnd: lines.end,
              charStart: chars.start,
              charEnd: chars.end,
            }
          }

          const code = startEl.closest('[data-code-preview]')
          if (code !== null) {
            const lines = lineRangeWithin(code, startEl, endEl)
            const chars = offsetRange(code, range)
            return { kind: 'file', lineStart: lines.start, lineEnd: lines.end, charStart: chars.start, charEnd: chars.end }
          }

          return { kind: 'dom' }
        }

        /** 锚点根元素：消息行或文件预览外壳。 */
        function anchorRoot(source) {
          if (source === null || source === undefined) return null
          if (source.kind === 'message' && source.anchorKey) {
            return (
              document.querySelector(`[data-chat-anchor-key="${cssEscape(source.anchorKey)}"]`) ??
              document.querySelector(`[data-chat-flow-key="${cssEscape(source.anchorKey)}"]`)
            )
          }
          if (source.kind === 'file' && source.sourceUrl) {
            return document.querySelector(`[data-textpreview-url="${cssEscape(source.sourceUrl)}"]`)
          }
          if (source.kind === 'file') return document.querySelector('[data-code-preview]')
          return null
        }

        function cssEscape(value) {
          return String(value).replace(/["\\]/g, '\\$&')
        }

        /** 按字符偏移在根元素里重建 Range（只走文本节点，偏移口径与 textContent 一致）。 */
        function rangeFromOffsets(root, start, length) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let offset = 0
          let startNode
          let startOffset = 0
          let endNode
          let endOffset = 0
          let node = walker.nextNode()
          while (node !== null) {
            const size = node.nodeValue === null ? 0 : node.nodeValue.length
            if (startNode === undefined && offset + size >= start) {
              startNode = node
              startOffset = start - offset
            }
            if (startNode !== undefined && offset + size >= start + length) {
              endNode = node
              endOffset = start + length - offset
              break
            }
            offset += size
            node = walker.nextNode()
          }
          if (startNode === undefined || endNode === undefined) return undefined
          return safe(() => {
            const range = document.createRange()
            range.setStart(startNode, Math.max(0, Math.min(startOffset, startNode.nodeValue.length)))
            range.setEnd(endNode, Math.max(0, Math.min(endOffset, endNode.nodeValue.length)))
            return range
          })
        }

        /** 在根元素里定位原文；重复片段用保存时的偏移择优。 */
        function matchInRoot(root, quote, savedOffset) {
          if (typeof quote !== 'string' || quote === '') return undefined
          const text = root.textContent ?? ''
          const positions = []
          let from = 0
          for (;;) {
            const at = text.indexOf(quote, from)
            if (at === -1 || positions.length >= 64) break
            positions.push(at)
            from = at + 1
          }
          if (positions.length === 0) return undefined
          let best = positions[0]
          if (positions.length > 1 && Number.isFinite(savedOffset)) {
            best = positions.reduce((a, b) => (Math.abs(b - savedOffset) < Math.abs(a - savedOffset) ? b : a))
          }
          return rangeFromOffsets(root, best, quote.length)
        }

        function rangeMatchesQuote(range, quote) {
          const current = safe(() => range.toString())
          if (typeof current !== 'string') return false
          const normalize = (value) => value.replace(/\s+/g, ' ').trim()
          return normalize(current) === normalize(quote)
        }

        /** 定位一条批注的当前 Range：活的 Range 优先，失效就按锚点 + 偏移重建。 */
        function locateRange(item) {
          if (item.liveRange !== undefined) {
            const live = item.liveRange
            const usable =
              safe(() => live.startContainer.isConnected === true && live.endContainer.isConnected === true) === true
            if (usable && rangeMatchesQuote(live, item.quote)) return live
            item.liveRange = undefined
          }
          const root = anchorRoot(item.source)
          if (root === null || root === undefined) return undefined
          const range = matchInRoot(root, item.quote, item.source.charStart)
          if (range !== undefined) item.liveRange = range
          return range
        }

        /* ------------------------------------------------------------------ 批注集合 */

        let sequence = 0

        function renumber() {
          annotations = annotations.map((item, index) => (item.number === index + 1 ? item : { ...item, number: index + 1 }))
        }

        function addAnnotation(input) {
          const quote = typeof input.quote === 'string' ? input.quote.trim().slice(0, MAX_QUOTE) : ''
          const note = typeof input.note === 'string' ? input.note.trim().slice(0, MAX_NOTE) : ''
          const source = input.source ?? { kind: 'dom' }
          // 空选区空批注没有意义。
          if (quote === '' && note === '') return undefined
          sequence += 1
          const item = {
            id: `sa-${Date.now().toString(36)}-${sequence}`,
            number: annotations.length + 1,
            quote,
            note,
            source,
            liveRange: input.liveRange,
            createdAt: Date.now(),
          }
          annotations = [...annotations, item]
          emit()
          scheduleSync()
          scheduleRepaint()
          return item
        }

        /** 改写一条既有批注的批注文字；原文与出处不变。 */
        function updateAnnotation(id, note) {
          const next = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : ''
          let hit = false
          annotations = annotations.map((item) => {
            if (item.id !== id) return item
            hit = true
            return { ...item, note: next }
          })
          if (!hit) return
          emit()
          scheduleSync()
          scheduleRepaint()
        }

        function removeAnnotation(id) {
          annotations = annotations.filter((item) => item.id !== id)
          renumber()
          emit()
          scheduleSync()
          scheduleRepaint()
        }

        function clearAnnotations() {
          annotations = []
          // 注意：不要在这里清 draftIds —— 交给 syncAttachment 才能把已挂上的附件摘掉。
          emit()
          scheduleSync()
          scheduleRepaint()
        }

        /* ------------------------------------------------------- 原生附件块（随消息发送） */

        function describeSource(source) {
          if (source === null || source === undefined) return '未知出处'
          if (source.kind === 'message') {
            const role = source.flowKind === 'user' || source.flowKind === 'steering' ? '用户消息' : '助手回复'
            return `${role}（锚点 ${source.anchorKey || '-'}）`
          }
          if (source.kind === 'file') {
            const path = source.path ?? '(未知路径)'
            let where = ''
            if (Number.isFinite(source.lineStart)) {
              where =
                Number.isFinite(source.lineEnd) && source.lineEnd !== source.lineStart
                  ? ` 第 ${source.lineStart}–${source.lineEnd} 行`
                  : ` 第 ${source.lineStart} 行`
            }
            return `工作区文件 \`${path}\`${where}`
          }
          return '页面选区'
        }

        /**
         * 批注负载：一个自描述的 JSON 数据块。
         *
         * 用 JSON 而不是 Markdown，是因为位置是要被程序化使用的东西 —— 行号、字符区间、
         * 锚点键 —— 结构化字段才不会在自然语言里糊掉。
         */
        function buildPayload(items) {
          return JSON.stringify(
            {
              kind: PAYLOAD_KIND,
              version: 1,
              instruction:
                '这是用户随上一条消息附加的批注数据块，与用户消息正文是相互独立的两部分，不属于正文。' +
                'annotations[].quote 是用户选中的原文；annotations[].source 给出它的位置：' +
                '工作区文件用 path + lineStart/lineEnd（1 基行号）+ charStart/charEnd；' +
                '对话消息用 role + anchorKey + charStart/charEnd。' +
                'charStart/charEnd 是半开区间 [charStart, charEnd)，以该锚点元素正文的 textContent 为口径。' +
                '请按 index 逐条对照回应。',
              count: items.length,
              annotations: items.map((item) => ({
                index: item.number,
                quote: item.quote,
                note: item.note,
                source: payloadSource(item.source),
              })),
            },
            null,
            2,
          )
        }

        /** 只把有意义的字段放进 JSON，避免一堆 null 噪声。 */
        function payloadSource(source) {
          const out = { kind: source?.kind ?? 'dom' }
          if (source?.kind === 'message') {
            out.role = source.role ?? (source.flowKind === 'user' || source.flowKind === 'steering' ? 'user' : 'assistant')
            if (typeof source.anchorKey === 'string' && source.anchorKey !== '') out.anchorKey = source.anchorKey
            if (typeof source.flowKind === 'string' && source.flowKind !== '') out.flowKind = source.flowKind
          } else if (source?.kind === 'file') {
            if (typeof source.path === 'string' && source.path !== '') out.path = source.path
            if (Number.isFinite(source.lineStart)) out.lineStart = source.lineStart
            if (Number.isFinite(source.lineEnd)) out.lineEnd = source.lineEnd
          }
          if (Number.isFinite(source?.charStart)) out.charStart = source.charStart
          if (Number.isFinite(source?.charEnd)) out.charEnd = source.charEnd
          return out
        }

        function scheduleSync() {
          if (syncTimer !== null) window.clearTimeout(syncTimer)
          syncTimer = window.setTimeout(() => {
            syncTimer = null
            void syncAttachment()
          }, UPLOAD_DEBOUNCE_MS)
        }

        /** 摘掉一批草稿附件：既要从输入态移除，也要让运行时释放（否则会漏掉后台任务）。 */
        function releaseDrafts(ids, shell) {
          if (ids.length === 0) return
          const previousGuard = maintaining
          maintaining = true
          try {
            for (const id of ids) safe(() => shell.removeAttachment(id))
            const conversation = ctx.conversation
            for (const id of ids) safe(() => conversation?.releaseDraftAttachment?.(id))
          } finally {
            maintaining = previousGuard
          }
        }

        /**
         * 等运行时把草稿附件传完。
         *
         * 这一步不能省：`sendSession` 在 `fileUploads[id].status !== 'ready'` 时直接抛
         * 「one or more files have not finished uploading」，会让整条消息发送失败。
         * 所以只在 ready 之后才把附件挂进输入态 —— 宁可晚几百毫秒，也绝不制造发送失败。
         * @returns 是否全部就绪。
         */
        function waitForUploads(conversation, ids, timeoutMs) {
          const store = conversation?.fileUploads
          if (store === undefined || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') {
            return Promise.resolve(true)
          }
          return new Promise((resolve) => {
            let settled = false
            let unsubscribe
            let timer = null
            const finish = (value) => {
              if (settled) return
              settled = true
              if (typeof unsubscribe === 'function') safe(unsubscribe)
              if (timer !== null) window.clearTimeout(timer)
              resolve(value)
            }
            const check = () => {
              if (settled) return
              const snapshot = safe(() => store.getSnapshot())
              if (snapshot === undefined || snapshot === null) return
              let pending = 0
              for (const id of ids) {
                const entry = snapshot[id]
                if (entry === undefined) {
                  pending += 1
                  continue
                }
                if (entry.status === 'error') {
                  finish(false)
                  return
                }
                if (entry.status !== 'ready') pending += 1
              }
              if (pending === 0) finish(true)
            }
            const result = safe(() => store.subscribe(() => check()))
            unsubscribe = typeof result === 'function' ? result : undefined
            timer = window.setTimeout(() => finish(false), timeoutMs)
            if (settled) {
              if (typeof unsubscribe === 'function') safe(unsubscribe)
              window.clearTimeout(timer)
            }
            check()
          })
        }

        /** 运行时是否提供了这条官方附件链路（拖拽/粘贴附件走的就是它）。 */
        function draftAttachmentSupported(conversation, shell) {
          return (
            typeof conversation?.createDrafts === 'function' &&
            typeof shell?.addFiles === 'function' &&
            typeof shell?.removeAttachment === 'function'
          )
        }

        /**
         * 把批注集合变成一个**原生草稿附件**随消息提交。
         *
         * 走运行时自己的 `createDrafts` + 输入外壳的 `addFiles` —— 与拖拽/粘贴附件完全同一条
         * 链路（`dsh-client-ui-conversation` 的 drop 处理器就是这么用的）。这样得到的那条用户
         * 消息 content 天然是 `[{type:'text'}, {type:'file'}]` 两个独立块，而不是把批注文本拼进正文。
         *
         * 反例（曾经踩过）：只调 `addAttachments(ids)` 是不够的 —— 那只往输入态塞 id，运行时
         * 私有的 `draftAttachments` 里没有对应条目，发送时 `resolveDraftAttachments` 解析不到，
         * 结果是批注根本进不了消息（或直接抛错）。必须让运行时自己登记草稿附件。
         */
        async function syncAttachment() {
          if (syncing) {
            scheduleSync()
            return
          }
          syncing = true
          const previous = draftIds
          try {
            const shell = inputShell()
            const conversation = ctx.conversation
            const sessionId = currentSessionId()

            if (shell === undefined || sessionId === undefined) {
              draftIds = []
              return
            }
            if (!draftAttachmentSupported(conversation, shell)) {
              console.warn('[selection-annotations] 运行时未提供 createDrafts/addFiles，批注不会随消息发送')
              draftIds = []
              return
            }

            // 先摘旧的，避免一条消息上挂两份批注块。
            releaseDrafts(previous, shell)
            draftIds = []
            draftSeen = false

            if (annotations.length === 0) return

            const file = new File([buildPayload(annotations)], ANNOTATION_FILE, { type: 'application/json' })
            const drafts = conversation.createDrafts(sessionId, [file])
            const ids = Array.isArray(drafts) ? drafts.map((draft) => draft.id).filter((id) => typeof id === 'string') : []
            if (ids.length === 0) return

            if (!(await waitForUploads(conversation, ids, UPLOAD_READY_TIMEOUT_MS))) {
              console.warn('[selection-annotations] 批注附件上传失败，本次不随消息发送')
              releaseDrafts(ids, shell)
              return
            }

            draftIds = ids
            draftSeen = false
            // 先订阅再挂载：挂载本身会发布一次输入态，那次「在场」必须被看到，
            // 否则发送导致的「离场」会被误判成「还没挂上」而拒绝清空。
            watchDraft()
            if (safe(() => shell.addFiles([], ids)) === false) {
              draftIds = []
              releaseDrafts(ids, shell)
              return
            }
            console.log(`[selection-annotations] 批注块已挂到本条消息（${annotations.length} 条）`)
          } catch (err) {
            console.warn('[selection-annotations] 批注附件同步失败：', err)
          } finally {
            syncing = false
            maintaining = false
          }
        }

        /* ------------------------------------------------------------------ 覆盖层绘制 */

        const overlay = document.createElement('div')
        overlay.className = 'sa-overlay'
        overlay.setAttribute('data-sa-ui', 'overlay')

        function scheduleRepaint() {
          if (repaintTimer !== null) return
          repaintTimer = window.setTimeout(() => {
            repaintTimer = null
            repaint()
          }, REPAINT_MS)
        }

        function repaint() {
          overlay.textContent = ''
          if (annotations.length === 0) return
          for (const item of annotations) {
            const range = locateRange(item)
            if (range === undefined) continue
            const rects = safe(() => [...range.getClientRects()]) ?? []
            let badged = false
            for (const rect of rects) {
              if (rect.width <= 0 || rect.height <= 0) continue
              const box = document.createElement('div')
              box.className = 'sa-hl'
              box.style.left = `${rect.left}px`
              box.style.top = `${rect.top}px`
              box.style.width = `${rect.width}px`
              box.style.height = `${rect.height}px`
              overlay.appendChild(box)
              if (!badged) {
                badged = true
                // 角标是唯一的「从正文直接回到这条批注」的入口，必须可点击。
                const badge = document.createElement('button')
                badge.type = 'button'
                badge.className = 'sa-badge'
                badge.textContent = String(item.number)
                badge.style.left = `${rect.left - 11}px`
                badge.style.top = `${rect.top - 8}px`
                badge.title = item.note === '' ? item.quote : `${item.quote}\n\n批注：${item.note}`
                badge.addEventListener('click', (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  openEditPopover(item.id, badge)
                })
                overlay.appendChild(badge)
              }
            }
          }
        }

        /* ------------------------------------------------------------------ 选区工具条 */

        const toolbar = document.createElement('div')
        toolbar.className = 'sa-toolbar'
        toolbar.setAttribute('data-sa-ui', 'toolbar')
        const annotateButton = document.createElement('button')
        annotateButton.type = 'button'
        annotateButton.className = 'sa-btn'
        annotateButton.textContent = '批注'
        toolbar.appendChild(annotateButton)

        const popover = document.createElement('div')
        popover.className = 'sa-popover'
        popover.setAttribute('data-sa-ui', 'popover')
        const popTitle = document.createElement('div')
        popTitle.className = 'sa-pop-title'
        const popQuote = document.createElement('div')
        popQuote.className = 'sa-pop-quote'
        const popSource = document.createElement('div')
        popSource.className = 'sa-pop-src'
        const popInput = document.createElement('textarea')
        popInput.className = 'sa-pop-input'
        popInput.placeholder = '写点什么（可以留空，只标记原文）'
        const popActions = document.createElement('div')
        popActions.className = 'sa-pop-actions'
        const popDelete = document.createElement('button')
        popDelete.type = 'button'
        popDelete.className = 'sa-link sa-pop-delete'
        popDelete.textContent = '删除'
        const popSpacer = document.createElement('span')
        popSpacer.className = 'sa-pop-spacer'
        const popCancel = document.createElement('button')
        popCancel.type = 'button'
        popCancel.className = 'sa-link'
        popCancel.textContent = '取消'
        const popSave = document.createElement('button')
        popSave.type = 'button'
        popSave.className = 'sa-btn'
        popSave.textContent = '保存'
        popActions.append(popDelete, popSpacer, popCancel, popSave)
        popover.append(popTitle, popQuote, popSource, popInput, popActions)

        function isExcluded(node) {
          const element = elementOf(node)
          if (element === null) return true
          if (element.closest('[data-sa-ui]') !== null) return true
          if (element.closest('[data-composer-card],[data-composer-input],[data-input-scroll]') !== null) return true
          if (element.closest('input,textarea,[contenteditable="true"]') !== null) return true
          return false
        }

        function readSelection() {
          const selection = window.getSelection()
          if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
          const range = selection.getRangeAt(0)
          const quote = range.toString()
          if (quote.trim() === '') return null
          if (isExcluded(range.startContainer) || isExcluded(range.endContainer)) return null
          return { range, quote }
        }

        function hideToolbar() {
          toolbar.dataset.open = '0'
        }

        function placeAt(element, rect, gap) {
          const width = element.offsetWidth || 80
          const height = element.offsetHeight || 32
          const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))
          const above = rect.top - height - gap
          const top = above < 8 ? Math.min(rect.bottom + gap, window.innerHeight - height - 8) : above
          element.style.left = `${left}px`
          element.style.top = `${Math.max(8, top)}px`
        }

        function onSelectionChange() {
          window.clearTimeout(settleTimer)
          settleTimer = window.setTimeout(() => {
            settleTimer = null
            const selection = readSelection()
            if (selection === null) {
              hideToolbar()
              return
            }
            const rect = safe(() => selection.range.getBoundingClientRect())
            if (rect === undefined || (rect.width === 0 && rect.height === 0)) {
              hideToolbar()
              return
            }
            pendingSelection = selection
            toolbar.dataset.open = '1'
            placeAt(toolbar, rect, 8)
          }, SETTLE_MS)
        }

        /** 弹层两种用途：新建（来自当前选区）与修改（某一条既有批注）。 */
        let popoverMode = 'create'
        let popoverAnchor = null
        let popoverTargetId = null

        function showPopover(options) {
          popTitle.textContent = options.title
          popQuote.textContent = options.quote.length > 400 ? `${options.quote.slice(0, 400)}…` : options.quote
          popQuote.style.display = options.quote === '' ? 'none' : ''
          popSource.textContent = options.sourceText
          popInput.value = options.note
          popoverMode = options.mode
          popoverTargetId = options.targetId ?? null
          popDelete.style.display = options.mode === 'edit' ? '' : 'none'
          hideToolbar()
          popover.dataset.open = '1'
          if (options.rect !== undefined && options.rect !== null) placeAt(popover, options.rect, 10)
          safe(() => popInput.focus())
          safe(() => popInput.setSelectionRange(popInput.value.length, popInput.value.length))
        }

        function openCreatePopover() {
          const selection = pendingSelection
          if (selection === null) return
          popoverAnchor = { range: selection.range, quote: selection.quote, source: captureSource(selection.range) }
          showPopover({
            title: '新建批注',
            quote: selection.quote,
            sourceText: describeSource(popoverAnchor.source),
            note: '',
            rect: safe(() => selection.range.getBoundingClientRect()),
            mode: 'create',
            targetId: null,
          })
        }

        /**
         * 修改一条既有批注。
         * 这是编号角标点击后的默认行为 —— 点它是要改这一条，不是打开列表。
         * @param id - 目标批注 id。
         * @param anchor - 用来定位弹层的元素（角标或列表里的「编辑」按钮）。
         */
        function openEditPopover(id, anchor) {
          const item = annotations.find((candidate) => candidate.id === id)
          if (item === undefined) return
          const measured = safe(() => anchor?.getBoundingClientRect())
          const rect =
            measured ??
            {
              left: window.innerWidth / 2 - 40,
              top: window.innerHeight / 2,
              width: 80,
              height: 0,
              right: window.innerWidth / 2 + 40,
              bottom: window.innerHeight / 2,
            }
          popoverAnchor = null
          showPopover({
            title: `修改批注 #${item.number}`,
            quote: item.quote,
            sourceText: describeSource(item.source),
            note: item.note,
            rect,
            mode: 'edit',
            targetId: id,
          })
        }

        function closePopover() {
          popover.dataset.open = '0'
          popoverAnchor = null
          popoverTargetId = null
          popoverMode = 'create'
        }

        function commitPopover() {
          if (popoverMode === 'edit') {
            const target = popoverTargetId
            closePopover()
            if (target !== null) updateAnnotation(target, popInput.value)
            return
          }
          const anchor = popoverAnchor
          if (anchor === null) return
          addAnnotation({
            quote: anchor.quote,
            note: popInput.value,
            source: anchor.source,
            liveRange: anchor.range,
          })
          closePopover()
          safe(() => window.getSelection()?.removeAllRanges())
        }

        function deleteFromPopover() {
          const target = popoverTargetId
          closePopover()
          if (target !== null) removeAnnotation(target)
        }

        annotateButton.addEventListener('mousedown', (event) => {
          // 保住选区：点按钮不应清掉它。
          event.preventDefault()
        })
        annotateButton.addEventListener('click', (event) => {
          event.preventDefault()
          openCreatePopover()
        })
        popCancel.addEventListener('click', () => closePopover())
        popSave.addEventListener('click', () => commitPopover())
        popDelete.addEventListener('click', () => deleteFromPopover())
        popInput.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closePopover()
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commitPopover()
        })
        document.addEventListener('pointerdown', (event) => {
          if (popover.dataset.open !== '1') return
          const target = elementOf(event.target)
          if (target !== null && target.closest('[data-sa-ui="popover"]') !== null) return
          closePopover()
        }, true)
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            hideToolbar()
            closePopover()
          }
        })
        /* ------------------------------------------- 批注按钮 + 悬浮批注面板 */

        function sourceSummary(item) {
          const source = item.source
          if (source?.kind === 'message') return source.flowKind === 'user' ? '用户消息' : '助手回复'
          if (source?.kind === 'file') {
            const path = source.path ?? '文件'
            return Number.isFinite(source.lineStart) ? `${path}:${source.lineStart}` : path
          }
          return '选区'
        }

        // 面板是挂在 body 上的原生 DOM（position: fixed），**完全不参与布局**：
        // 既不会把输入框顶上去，也不受 composer 行内样式/滚动容器影响。
        // 触发按钮则在 composer 的 input.right 槽位里，紧挨发送按钮。
        const panelRoot = document.createElement('div')
        panelRoot.className = 'sa-float'
        panelRoot.setAttribute('data-sa-ui', 'panel')
        panelRoot.style.display = 'none'
        const panelEl = document.createElement('div')
        panelEl.className = 'sa-panel'
        panelEl.setAttribute('data-sa-ui', 'panel')
        panelRoot.appendChild(panelEl)

        let panelOpen = false
        let panelAnchor = null

        function el(tag, className, text) {
          const created = document.createElement(tag)
          if (className !== undefined) created.className = className
          if (text !== undefined) created.textContent = text
          return created
        }

        function button(className, text, onClick) {
          const created = el('button', className, text)
          created.type = 'button'
          created.addEventListener('click', onClick)
          return created
        }

        /** 面板贴着按钮放，优先在按钮上方；空间不够就落到下方。 */
        function positionPanel() {
          if (!panelOpen || panelAnchor === null) return
          const rect = safe(() => panelAnchor.getBoundingClientRect())
          if (rect === undefined) return
          const width = panelEl.offsetWidth || 360
          const height = panelEl.offsetHeight || 240
          const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
          const above = rect.top - height - 8
          const top = above < 8 ? Math.min(rect.bottom + 8, window.innerHeight - height - 8) : above
          panelRoot.style.left = `${left}px`
          panelRoot.style.top = `${Math.max(8, top)}px`
        }

        function renderPanel() {
          panelEl.textContent = ''

          if (annotations.length === 0) {
            panelEl.appendChild(el('div', 'sa-hint', '选中回复、消息或文件预览里的文字，点浮动「批注」即可。'))
          }

          for (const item of annotations) {
            const row = el('div', 'sa-item')
            const head = el('div', 'sa-item-head')
            head.appendChild(el('span', 'sa-item-num', `#${item.number}`))
            const summary = el('span', 'sa-item-src', sourceSummary(item))
            summary.title = summary.textContent
            head.appendChild(summary)
            head.appendChild(button('sa-link', '编辑', () => openEditPopover(item.id, head)))
            head.appendChild(button('sa-link', '删除', () => removeAnnotation(item.id)))
            row.appendChild(head)
            if (item.quote !== '') row.appendChild(el('div', 'sa-item-quote', item.quote))
            if (item.note !== '') row.appendChild(el('div', 'sa-item-note', item.note))
            panelEl.appendChild(row)
          }

          const foot = el('div', 'sa-foot')
          if (annotations.length > 0) foot.appendChild(button('sa-link', '清空', () => clearAnnotations()))
          foot.appendChild(el('span', 'sa-hint', '发送时批注作为独立块随消息提交'))
          panelEl.appendChild(foot)
        }

        function openPanel(anchor) {
          panelOpen = true
          panelAnchor = anchor
          panelRoot.style.display = ''
          renderPanel()
          positionPanel()
          emit()
        }

        function closePanel() {
          if (!panelOpen) return
          panelOpen = false
          panelAnchor = null
          panelRoot.style.display = 'none'
          emit()
        }

        function togglePanel(anchor) {
          if (panelOpen) closePanel()
          else openPanel(anchor)
        }

        document.addEventListener(
          'pointerdown',
          (event) => {
            if (!panelOpen) return
            const target = elementOf(event.target)
            if (target === null) return
            if (target.closest('[data-sa-ui="panel"]') !== null) return
            if (target.closest('.sa-chip') !== null) return
            closePanel()
          },
          true,
        )
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closePanel()
        })

        // 批注集合或面板开合变化时重渲染面板正文（订阅由 store 的 emit 驱动）。
        subscribe(() => {
          if (panelOpen) {
            renderPanel()
            positionPanel()
          }
        })

        /** composer 工具行里的触发按钮（紧挨发送按钮），只占一个紧凑控件位。 */
        function AnnotateButton(props) {
          const [local, setLocal] = React.useState(() => ({ items: snapshot(), open: panelOpen }))
          const propSessionId = props?.sessionId
          const propInputActions = props?.inputActions
          if (typeof propSessionId === 'string' && propSessionId !== '') latestSessionId = propSessionId
          if (propInputActions !== undefined && propInputActions !== null) latestInputActions = propInputActions

          React.useEffect(() => subscribe(() => setLocal({ items: snapshot(), open: panelOpen })), [])
          React.useEffect(() => {
            if (typeof propSessionId === 'string' && propSessionId !== '') adoptSession(propSessionId)
          }, [propSessionId])

          const count = local.items.length
          return h(
            'button',
            {
              className: local.open ? 'sa-chip sa-chip-open' : 'sa-chip',
              type: 'button',
              title: count === 0 ? '还没有批注：选中正文或文件里的文字后点浮动「批注」' : '查看 / 管理批注',
              onClick: (event) => togglePanel(event.currentTarget),
            },
            count === 0 ? '批注' : `批注 ×${count}`,
          )
        }
        /* ------------------------------------------------------------------ 生命周期 */

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-selection-annotations', '')
          style.textContent = CSS
          document.head.appendChild(style)
          document.body.append(overlay, toolbar, popover, panelRoot)
          return () => {
            style.remove()
            overlay.remove()
            toolbar.remove()
            popover.remove()
            panelRoot.remove()
          }
        })

        ctx.effect(() => {
          document.addEventListener('selectionchange', onSelectionChange)
          const onViewport = () => {
            scheduleRepaint()
            positionPanel()
          }
          window.addEventListener('scroll', onViewport, true)
          window.addEventListener('resize', onViewport)
          // 只对「不是我们自己写出来的」DOM 变化重绘：否则 repaint 写 overlay 会再次触发观察器，
          // 形成 120ms 自激循环，把输入卡死。
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              const target = elementOf(record.target)
              if (target !== null && target.closest('[data-sa-ui]') !== null) continue
              scheduleRepaint()
              return
            }
          })
          observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          return () => {
            document.removeEventListener('selectionchange', onSelectionChange)
            window.removeEventListener('scroll', onViewport, true)
            window.removeEventListener('resize', onViewport)
            observer.disconnect()
          }
        })

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'selection-annotations', order: 30 }, AnnotateButton),
        )

        // 便于人工核对与排障：window.__dshSelectionAnnotations.list() 等。
        // `add` 与 `_internals` 同时给无浏览器的测试台用（见 test/client-half.test.mjs）。
        window.__dshSelectionAnnotations = {
          list: () =>
            snapshot().map((item) => ({
              id: item.id,
              number: item.number,
              quote: item.quote,
              note: item.note,
              source: item.source,
            })),
          payload: () => buildPayload(annotations),
          receipt: () => draftIds[0] ?? null,
          drafts: () => [...draftIds],
          session: () => currentSessionId(),
          repaint,
          remove: removeAnnotation,
          clear: clearAnnotations,
          update: (id, note) => updateAnnotation(id, note),
          add: (input) => addAnnotation(input),
          _internals: { buildPayload, payloadSource, describeSource, captureSource, matchInRoot, rangeFromOffsets, offsetRange, anchorRoot },
        }
      },
    }
  },
})
