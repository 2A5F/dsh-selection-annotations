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
    /** 拉取式消费检测的间隔：不依赖 composer 是否发布通知。 */
    const CONSUME_POLL_MS = 1000
    /** 输入态说「附件没了」之后，隔多久向运行时求证（提交可能只是暂时移走）。 */
    const CONSUME_CONFIRM_MS = 400
    /**
     * 构建标记：DSH Desktop 没有 DevTools 控制台，没法用日志确认「客户端跑的是哪一版」，
     * 所以把标记显示在面板页脚 —— 改动这个字符串就相当于一个版本探针。
     */
    const BUILD_TAG = '诊断#9'
    /** 读源文件求行号的超时；超时就退回渲染坐标，不拖住保存。 */
    const SOURCE_LOOKUP_TIMEOUT_MS = 600
    /** 认领「上一轮遗留的孤儿批注附件」的间隔。 */
    const ORPHAN_SWEEP_MS = 1500
    /** 首次上传最多为在途的位置精修等多久 —— 精修通常几十毫秒，这只是个上限。 */
    const REFINE_WAIT_MS = 1200
    /** 发出后仍可能被运行时 restore 回来的孤儿附件，要盯多久。 */
    const STRAY_GUARD_MS = 120000

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
      // 客户端上下文只把**已声明的**服务/命名空间挂到 ctx 上：
      // `remote` 是远程门面，`remote.workspaceFiles` 是其中一个命名空间。少声明一个，
      // 取值就会直接抛（实测 `remote.workspaceFiles` 抛，导致读原文整条失败）——
      // 官方同类插件（dsh-client-ui-sidebar-documentpreview、dsh-api-workspace-files）都这么写。
      inject: ['slots', 'sessions', 'conversation', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
    /**
     * 客户端半边只提供 `console.log` 与 `console.error` —— **没有 `console.warn`**。
     * 而且日志本身不该有能力搞坏主流程（一次 console.warn 抛错就会把整条精修链路打断），
     * 所以统一包一层，绝不外抛。
     */
    const log = (message, ...rest) => {
      try {
        log(message, ...rest)
      } catch {
        /* 日志失败无所谓 */
      }
    }
    const warn = (message, ...rest) => {
      try {
        console.error(message, ...rest)
      } catch {
        /* 日志失败无所谓 */
      }
    }
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
        let watchTimer = null
        let consumeTimer = null
        /** 在途的位置精修；上传前会等它，让首次上传就带上最终结果。 */
        let pendingRefine = undefined
        /** 定期认领孤儿附件的计时器。 */
        let orphanTimer = null
        /** 只打一次「经哪条路读到原文」，避免刷屏。 */
        let refineLogged = false
        /**
         * 诊断流水（临时手段）：DSH Desktop 没有 DevTools 控制台，日志无处可看，
         * 所以把位置精修的逐环节结果攒起来，随批注载荷一起发给模型 —— 用户只需照常发送。
         */
        const DIAGNOSTICS = []

        /** 记一行诊断；重复的相邻行不重复记。 */
        function noteDiag(line) {
          const text = String(line)
          if (DIAGNOSTICS[DIAGNOSTICS.length - 1] === text) return
          DIAGNOSTICS.push(text)
          if (DIAGNOSTICS.length > 24) DIAGNOSTICS.shift()
        }
        /** 已随消息发出、但运行时可能稍后 restore 回来的草稿附件 id → 守卫截止时间。 */
        const strayIds = new Map()

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
              warn('[selection-annotations] 订阅回调失败：', err)
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
         * 输入外壳**实时**持有的草稿附件 id。
         *
         * 刻意不用运行时那张私有草稿表：只发附件（无正文）时，输入态已经交出了附件，
         * 但运行时仍会持有条目直到 admission 结算 —— 拿它当判据就永远等不到「已消费」。
         * @returns id 数组；拿不到时返回 undefined（此时不判定）。
         */
        function liveAttachmentIds(shell) {
          if (Array.isArray(shell?.attachmentIds)) return shell.attachmentIds
          const snapshot = safe(() => shell?.state?.getSnapshot())
          return Array.isArray(snapshot?.attachmentIds) ? snapshot.attachmentIds : undefined
        }

        /**
         * 清空之后仍要盯一会儿：提交**结算失败**时运行时会调 restoreAttachments 把附件塞回
         * 输入态（`settleDetachedFailure`），而这可能发生在回合结束很久之后。批注此刻其实已经
         * 发出，留下那张没有内容的卡片只会误导人，所以见到就摘。
         * @param shell - 当前输入外壳。
         */
        /**
         * 认领「上一轮遗留下来的孤儿批注附件」。
         *
         * 运行时在提交结算失败时会把已发出的附件 restore 回输入态；若那件事发生在插件重载之前
         * （或插件当时没在跑），内存里的守卫表就随重载一起没了，那份 `批注.json` 会一直赖在输入框里，
         * 下次发送又被带上 —— 同一批批注就被重复送给模型。
         *
         * 所以判据不放在内存里，而放在**文件名**上：凡是我们没在跟踪的批注附件，一律摘掉。
         * @param shell - 当前输入外壳。
         */
        function sweepOrphans(shell) {
          if (maintaining || syncing) return
          const ids = liveAttachmentIds(shell)
          if (ids === undefined || ids.length === 0) return
          const foreign = ids.filter((id) => !draftIds.includes(id))
          if (foreign.length === 0) return
          const resolved = safe(() => ctx.conversation?.resolveDraftAttachments?.(foreign))
          if (!Array.isArray(resolved)) return
          for (const attachment of resolved) {
            if (attachment?.file?.name !== ANNOTATION_FILE) continue
            releaseDrafts([attachment.id], shell)
            log(`[selection-annotations] 摘掉一个上一轮遗留的孤儿批注附件（${attachment.id}）`)
          }
        }

        function sweepStrays(shell) {
          if (strayIds.size === 0 || shell === undefined) return
          const now = Date.now()
          const ids = liveAttachmentIds(shell)
          if (ids === undefined) return
          for (const [id, until] of [...strayIds]) {
            if (until <= now) {
              strayIds.delete(id)
              continue
            }
            if (!ids.includes(id)) continue
            strayIds.delete(id)
            releaseDrafts([id], shell)
            log(`[selection-annotations] 摘掉一个被恢复回来的孤儿批注附件（${id}）`)
          }
        }

        /**
         * 判定「这批批注已经被消息消费掉」并清空 —— 带一次性保护。
         * @param reason - 触发原因，仅用于日志。
         */
        function markConsumed(reason) {
          if (draftIds.length === 0) return
          const ids = draftIds
          draftIds = []
          draftSeen = false
          const until = Date.now() + STRAY_GUARD_MS
          for (const id of ids) strayIds.set(id, until)
          if (annotations.length === 0) return
          annotations = []
          emit()
          scheduleRepaint()
          log(`[selection-annotations] 批注已随消息发出（${reason}）`)
        }

        /**
         * 先看到「输入态不再持有附件」之后，隔一拍再确认一次：提交失败会调 restoreAttachments
         * 把附件还回来，那时就不该清空（否则批注清了、附件还在，两边对不上）。
         */
        function scheduleConsumeCheck() {
          if (consumeTimer !== null) return
          consumeTimer = window.setTimeout(() => {
            consumeTimer = null
            if (maintaining || draftIds.length === 0) return
            const shell = inputShell()
            if (shell === undefined) return
            const ids = liveAttachmentIds(shell)
            if (ids === undefined) return
            if (draftIds.some((id) => ids.includes(id))) return
            markConsumed('输入态已不再持有附件')
          }, CONSUME_CONFIRM_MS)
        }

        /**
         * 盯着批注附件何时被消费（消息发出）或被用户摘掉。
         *
         * 两条互补的信号，都归到同一个判据「输入态不再持有附件」：
         *   ① 输入态的**推送**通知 —— 快，但不能假定发送路径一定会发布通知；
         *   ② 直接轮询输入外壳的**实时字段** —— 慢一秒，但不依赖任何通知。
         * 确认窗口用来过滤「提交先移走、失败又还回来」的假信号。
         */
        function watchDraft() {
          const shell = inputShell()
          const state = shell?.state
          if (
            watchUnsub === undefined &&
            state !== undefined &&
            typeof state.subscribe === 'function' &&
            typeof state.getSnapshot === 'function'
          ) {
            watchUnsub = state.subscribe(() => {
              const current = inputShell()
              if (current !== undefined) sweepStrays(current)
              if (maintaining || draftIds.length === 0) return
              const snapshot = safe(() => state.getSnapshot())
              if (snapshot === undefined || snapshot === null) return
              const ids = Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds : []
              if (draftIds.some((id) => ids.includes(id))) {
                draftSeen = true
                return
              }
              // 首次「在场」没被看到之前不敢下结论：那可能只是还没挂上去。
              if (!draftSeen) return
              scheduleConsumeCheck()
            })
          }
          if (watchTimer === null) {
            watchTimer = window.setInterval(() => {
              const current = inputShell()
              if (current === undefined) return
              sweepStrays(current)
              sweepOrphans(current)
              if (maintaining || draftIds.length === 0) return
              const ids = liveAttachmentIds(current)
              if (ids === undefined) return
              if (draftIds.some((id) => ids.includes(id))) return
              scheduleConsumeCheck()
            }, CONSUME_POLL_MS)
          }
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

        /** 空白折叠成单个空格，并记下每个规范化字符对应的源文本下标。 */
        function normalizeWithMap(value) {
          const chars = []
          const map = []
          let spaceAt = -1
          for (let i = 0; i < value.length; i += 1) {
            const ch = value[i]
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
              if (spaceAt === -1) spaceAt = i
              continue
            }
            if (spaceAt !== -1) {
              if (chars.length > 0) {
                chars.push(' ')
                map.push(spaceAt)
              }
              spaceAt = -1
            }
            chars.push(ch)
            map.push(i)
          }
          return { text: chars.join(''), map }
        }

        /**
         * 在**源文件文本**里定位引文。
         *
         * 渲染后的正文与原文并不一样（标题丢了 `#`、强调丢了 `**`、链接只剩文字），而且换行、
         * 缩进也会被重排，所以不能直接 `indexOf`：先把两边都做空白折叠再比，命中后把区间映射回
         * 源文本下标。找不到就返回 undefined —— 那时宁可不要行号，也不要给一个错的。
         * @returns { start, end } 源文本里的半开区间。
         */
        function locateInSource(source, quote) {
          const needle = quote.replace(/\s+/g, ' ').trim()
          if (needle === '') return undefined
          const hay = normalizeWithMap(source)
          const at = hay.text.indexOf(needle)
          if (at === -1) return undefined
          const start = hay.map[at]
          const end = hay.map[at + needle.length - 1]
          if (start === undefined || end === undefined) return undefined
          return { start, end: end + 1 }
        }

        /** 源文本里某个下标所处的 1 基行号。 */
        function lineOfOffset(text, offset) {
          let line = 1
          const limit = Math.max(0, Math.min(offset, text.length))
          for (let i = 0; i < limit; i += 1) if (text.charCodeAt(i) === 10) line += 1
          return line
        }

        /**
         * 给一次远端调用套上超时，并且**不吞掉失败原因** ——
         * 返回 `{ ok: true, value }` 或 `{ ok: false, reason }`，便于把「超时」与「抛错」分开。
         */
        function withTimeout(promise, ms) {
          return new Promise((resolve) => {
            let settled = false
            const settle = (outcome) => {
              if (settled) return
              settled = true
              window.clearTimeout(timer)
              resolve(outcome)
            }
            const timer = window.setTimeout(() => settle({ ok: false, reason: `${ms}ms 内没有返回` }), ms)
            Promise.resolve(promise).then(
              (value) => settle({ ok: true, value }),
              (error) => settle({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
            )
          })
        }

        /** 远端结果可能是裸值，也可能是 { ok, value } 包装。 */
        function unwrapRemote(value) {
          if (value !== null && typeof value === 'object' && 'ok' in value && 'value' in value) {
            return value.ok === true ? value.value : undefined
          }
          return value
        }

        /**
         * 读源文件，把引文折算成**原文坐标**的行号与字符区间。
         *
         * 能拿到原文就用原文坐标（`textOrigin: source`）—— 这样 charStart/charEnd 在任何预览形态下
         * 都与文件一致，Markdown 也能有行号；拿不到就保留渲染坐标（`textOrigin: rendered`）。
         * @returns 覆盖用的字段，或 undefined。
         */

        async function resolveSourcePosition(source, quote, onSkip) {
          try {
            return await resolveSourcePositionInner(source, quote, onSkip)
          } catch (error) {
            // 抛错绝不能无声消失：桌面端没有控制台，唯一能看见它的地方就是这份诊断。
            noteDiag(`${String(source?.path)} → 抛错：${error instanceof Error ? error.message : String(error)}`)
            return undefined
          }
        }

        async function resolveSourcePositionInner(source, quote, onSkip) {
          /**
           * 精修失败一律安静退回，但要留下「断在哪一环」的证据。默认打到控制台；
           * 传了 onSkip 就交出去 —— 插件把它显示在面板里，用户不必开 F12。
           * @param reason - 断点描述。
           */
          const skip = (reason) => {
            log(`[selection-annotations] 位置精修跳过（${String(source?.path)}）：${reason}`)
            noteDiag(`${String(source?.path)} → ${reason}`)
            if (typeof onSkip === 'function') onSkip(reason)
            return undefined
          }
          if (source?.kind !== 'file') return undefined
          if (typeof source.path !== 'string' || source.path === '') return undefined
          const sessionId = currentSessionId()
          if (sessionId === undefined) return skip('拿不到当前会话 id')
          // 走客户端 remote 读原文；命名空间已在 inject 里声明，所以这里应当取得。
          // 客户端上下文的 remote 不止一种作用域：会话作用域要走 sessions.scope(id).remote，
          // 根上下文也可能直接带 remote。依次试，哪条能用用哪条。
          const candidates = []
          const agent = safe(() => ctx.sessions?.scope?.(sessionId))
          if (agent?.remote !== undefined) candidates.push({ label: 'sessions.scope().remote', remote: agent.remote })
          const direct = safe(() => ctx.remote) ?? safe(() => ctx.get('remote'))
          if (direct !== undefined) candidates.push({ label: 'ctx.remote', remote: direct })
          noteDiag(`候选 remote：${candidates.map((entry) => entry.label).join(' / ') || '一个都没有'}`)
          // 取命名空间可能抛错（typert facade 的属性访问会走代理），所以每个候选单独试并留证。
          let usable
          for (const entry of candidates) {
            const probe = safe(() => typeof entry.remote?.workspaceFiles?.read === 'function')
            if (probe === undefined) {
              noteDiag(`探测 ${entry.label}.workspaceFiles 抛错`)
              continue
            }
            if (probe === true) {
              usable = entry
              break
            }
            noteDiag(`探测 ${entry.label}.workspaceFiles：没有 read`)
          }
          if (usable === undefined) {
            return skip(`拿不到 remote.workspaceFiles.read（试过 ${candidates.map((e) => e.label).join(' / ') || '无任何 remote'}）`)
          }
          if (refineLogged === false) {
            refineLogged = true
            log(`[selection-annotations] 位置精修：经 ${usable.label} 读原文`)
          }
          noteDiag(`开始读取 ${source.path}`)
          const outcome = await withTimeout(
            safe(() => usable.remote.workspaceFiles.read(sessionId, source.path, {})),
            SOURCE_LOOKUP_TIMEOUT_MS,
          )
          noteDiag(`读取已返回：ok=${String(outcome.ok)}`)
          if (outcome.ok === false) return skip(`读取失败：${outcome.reason}`)
          const file = unwrapRemote(outcome.value)
          const text = typeof file?.text === 'string' ? file.text : undefined
          if (text === undefined) return skip('返回里没有 text（path 可能不被接受）')
          const hit = locateInSource(text, quote)
          if (hit === undefined) {
            return skip(
              file?.eof === false
                ? `引文不在读取窗口内（只拿到 ${text.length} 字符，eof=false）`
                : '引文不在原文里（多半是跨了行内 Markdown 标记）',
            )
          }
          noteDiag(`${source.path} → 读到原文（${text.length} 字符，经 ${usable.label}，行 ${lineOfOffset(text, hit.start)}）`)
          return {
            charStart: hit.start,
            charEnd: hit.end,
            lineStart: lineOfOffset(text, hit.start),
            lineEnd: lineOfOffset(text, Math.max(hit.start, hit.end - 1)),
            textOrigin: 'source',
          }
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
              // 默认口径是渲染后的正文；保存时会再试着读源文件改成 source。
              textOrigin: 'rendered',
            }
          }

          const code = startEl.closest('[data-code-preview]')
          if (code !== null) {
            const lines = lineRangeWithin(code, startEl, endEl)
            const chars = offsetRange(code, range)
            return { kind: 'file', lineStart: lines.start, lineEnd: lines.end, charStart: chars.start, charEnd: chars.end, textOrigin: 'rendered' }
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
                '这是用户发来的批注数据块。它与用户消息正文相互独立：用户可能同时发了正文，' +
                '也可能只发了这个批注块（此时它就是本条消息的全部内容）。' +
                'annotations[].quote 是用户选中的原文；annotations[].source 给出它的位置：' +
                '工作区文件用 path + lineStart/lineEnd（1 基行号）+ charStart/charEnd；' +
                '对话消息用 role + anchorKey + charStart/charEnd。' +
                'charStart/charEnd 是半开区间 [charStart, charEnd)，口径由 source.textOrigin 指明：' +
                '"source" = 文件原文的字符偏移，"rendered" = 该锚点元素渲染后正文的字符偏移。' +
                '工作区文件但凡能读到原文就给 "source"；拿不到原文（或引文跨了 Markdown 标记）时退回 "rendered"。' +
                '请按 index 逐条对照回应。',
              count: items.length,
              annotations: items.map((item) => ({
                index: item.number,
                quote: item.quote,
                note: item.note,
                source: payloadSource(item.source),
              })),
              // 临时：诊断随载荷一起发出去。桌面端没有控制台，这是唯一能拿到现场信息的通道。
              diagnostics: { build: BUILD_TAG, refine: DIAGNOSTICS.slice(-12) },
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
          if (out.kind === 'file' || out.kind === 'message') {
            out.textOrigin = source?.textOrigin === 'source' ? 'source' : 'rendered'
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
            // 等一次在途的位置精修：它通常几十毫秒就结束，这样**首次**上传就带上原文坐标与
            // 诊断；否则手快的用户发出的会是精修之前那一份（实测踩过）。
            if (pendingRefine !== undefined) {
              await Promise.race([
                pendingRefine,
                new Promise((resolve) => {
                  window.setTimeout(resolve, REFINE_WAIT_MS)
                }),
              ])
            }
            const shell = inputShell()
            const conversation = ctx.conversation
            const sessionId = currentSessionId()

            if (shell === undefined || sessionId === undefined) {
              draftIds = []
              return
            }
            if (!draftAttachmentSupported(conversation, shell)) {
              warn('[selection-annotations] 运行时未提供 createDrafts/addFiles，批注不会随消息发送')
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
              warn('[selection-annotations] 批注附件上传失败，本次不随消息发送')
              releaseDrafts(ids, shell)
              return
            }

            draftIds = ids
            draftSeen = false
            // 先订阅再挂载：挂载本身会发布一次输入态，那次「在场」必须被看到，
            // 否则发送导致的「离场」会被误判成「还没挂上」而拒绝清空。
            // 监控器只是事后清理，绝不能阻断挂载本身 —— 它失败了最多是「发完不清空」，
            // 但若让它把异常抛出去，就会连带 addFiles 一起跳过，批注根本发不出去。
            try {
              watchDraft()
            } catch (err) {
              warn('[selection-annotations] 消费检测挂载失败（不影响本次发送）：', err)
            }
            if (safe(() => shell.addFiles([], ids)) === false) {
              draftIds = []
              releaseDrafts(ids, shell)
              return
            }
            log(`[selection-annotations] 批注块已挂到本条消息（${annotations.length} 条）`)
          } catch (err) {
            warn('[selection-annotations] 批注附件同步失败：', err)
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

        /**
         * 位置精修：把渲染坐标升级成文件原文坐标。
         *
         * 刻意与「创建批注」解耦 —— 批注先落地，精修只是事后补的。这样任何读取或定位失败都
         * 只会让这条批注停在渲染坐标，而**不会让它根本建不出来**。（教训：上一版把精修放在
         * 创建之前，一次 remote 获取抛错就把整条创建跳过了。）
         * @param id - 要精修的批注 id。
         * @param source - 捕获时的来源（渲染坐标）。
         * @param quote - 引文。
         */
        /** 把精修失败的原因挂到那条批注上，面板会显示出来。 */
        function markRefineReason(id, reason) {
          let hit = false
          annotations = annotations.map((item) => {
            if (item.id !== id) return item
            hit = true
            return { ...item, refineReason: reason }
          })
          if (!hit) return
          emit()
          // 诊断也随载荷走：上传正在等我们时它会带上，否则补排一次。
          if (!syncing) scheduleSync()
          scheduleRepaint()
        }

        function refineSourcePosition(id, source, quote) {
          const task = (async () => {
            const precise = await safe(() =>
              resolveSourcePosition(source, quote, (reason) => markRefineReason(id, reason)),
            )
            if (precise === undefined) return
            let hit = false
            annotations = annotations.map((item) => {
              if (item.id !== id) return item
              hit = true
              return { ...item, source: { ...item.source, ...precise } }
            })
            if (!hit) return
            emit()
            // 上传正在等我们时不必再排一次（它会拿到最新结果）；否则补一次。
            if (!syncing) scheduleSync()
            scheduleRepaint()
          })()
          const guarded = task.catch((err) => {
            warn('[selection-annotations] 位置精修失败（不影响这条批注）：', err)
          })
          pendingRefine = guarded
          void guarded.then(() => {
            if (pendingRefine === guarded) pendingRefine = undefined
          })
          return guarded
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
          const note = popInput.value
          closePopover()
          // 先创建：这一段绝不能依赖任何可能失败的东西。
          const created = addAnnotation({
            quote: anchor.quote,
            note,
            source: anchor.source,
            liveRange: anchor.range,
          })
          safe(() => window.getSelection()?.removeAllRanges())
          // 再异步把位置精修到原文坐标；失败只记日志。
          if (created !== undefined) {
            refineSourcePosition(created.id, anchor.source, anchor.quote).catch((err) => {
              warn('[selection-annotations] 位置精修失败（不影响这条批注）：', err)
            })
          }
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
        popSave.addEventListener('click', () => {
          commitPopover()
        })
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
            const where = Number.isFinite(source.lineStart) ? `${path}:${source.lineStart}` : path
            // 行号是渲染坐标推出来的，未必等于文件真行号 —— 这一点要让用户看见。
            return source.textOrigin === 'source' ? where : `${where}（渲染坐标）`
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
            if (typeof item.refineReason === 'string' && item.refineReason !== '') {
              const why = el('div', 'sa-item-why', `位置精修未生效：${item.refineReason}`)
              why.style.fontSize = '11px'
              why.style.lineHeight = '1.5'
              why.style.opacity = '0.8'
              why.style.color = 'var(--dsw-alias-text-tertiary, GrayText)'
              why.style.marginTop = '2px'
              row.appendChild(why)
            }
            panelEl.appendChild(row)
          }

          const foot = el('div', 'sa-foot')
          if (annotations.length > 0) foot.appendChild(button('sa-link', '清空', () => clearAnnotations()))
          foot.appendChild(el('span', 'sa-hint', `发送时批注作为独立块随消息提交 · ${BUILD_TAG}`))
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
          // 独立于批注集合：即使现在一条批注都没有，也要能摘掉重载前遗留的孤儿附件。
          orphanTimer = window.setInterval(() => {
            const shell = inputShell()
            if (shell !== undefined) sweepOrphans(shell)
          }, ORPHAN_SWEEP_MS)
          return () => {
            style.remove()
            if (orphanTimer !== null) window.clearInterval(orphanTimer)
            orphanTimer = null
            if (watchTimer !== null) window.clearInterval(watchTimer)
            watchTimer = null
            if (consumeTimer !== null) window.clearTimeout(consumeTimer)
            consumeTimer = null
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
          _internals: { buildPayload, payloadSource, describeSource, captureSource, matchInRoot, rangeFromOffsets, offsetRange, anchorRoot, locateInSource, lineOfOffset, resolveSourcePosition, refineSourcePosition },
        }
      },
    }
  },
})
