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
    /** 读源文件求行号的超时；超时就退回渲染坐标，不拖住保存。 */
    const SOURCE_LOOKUP_TIMEOUT_MS = 600
    /** 认领「上一轮遗留的孤儿批注附件」的间隔。 */
    const ORPHAN_SWEEP_MS = 1500
    /** 首次上传最多为在途的位置精修等多久 —— 精修通常几十毫秒，这只是个上限。 */
    const REFINE_WAIT_MS = 1200
    /** 引用插入后等多久再弹批注框（Lexical 渲染引用块是异步的）。 */
    const QUOTE_PROMPT_MS = 80
    /** 距上一次用户手势超过这么久的新增引用，一律当作草稿恢复、不是刚插入。 */
    const QUOTE_GESTURE_MS = 2500
    /** 发出后仍可能被运行时 restore 回来的孤儿附件，要盯多久。 */
    const STRAY_GUARD_MS = 120000
    /** 一条「来路」里值得原样保留的字段：负载要用，回到原文画标记也要用。 */
    const ORIGIN_KEYS = [
      'path',
      'sourceUrl',
      'lineStart',
      'lineEnd',
      'charStart',
      'charEnd',
      // 渲染坐标要单独留一份：charStart/charEnd 会升级成原文坐标（给负载用），
      // 但页面里定位要高亮的仍是渲染后的正文，两者不能混用。
      'renderedCharStart',
      'renderedCharEnd',
      'textOrigin',
      'role',
      'anchorKey',
      'flowKind',
    ]

    const CSS = `
.sa-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.sa-hl { position: fixed; pointer-events: none; border-radius: 3px;
  background: rgb(255 208 66 / 0.45); box-shadow: inset 0 -1px 0 rgb(255 176 0 / 0.75); }
/* 引用块上的批注标记：不再自绘浮层（会和官方引用块重叠），只给引用原文加一条下划线。 */
[data-quote-preview][data-sa-number] { position: relative; }
[data-quote-preview][data-sa-number]::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 2px; border-radius: 2px; background: rgb(36 123 191 / 0.9); pointer-events: none; }
/* 批注 JSON 的附件卡片只是给宿主的信道：用户看到的「批注」就是输入框里的引用块，卡片本身不显示。 */
[data-sa-payload] { display: none !important; }
.sa-badge { position: fixed; pointer-events: auto; cursor: pointer; font: inherit; border: none; padding: 0 3px; min-width: 15px; height: 15px; padding: 0 3px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 8px;
  /* 主题的 brand 变量在这套配色里是浅色，白字会糊成一片 —— 角标固定蓝底白字。 */
  background: #247bbf; color: #fff; font-size: 10px; line-height: 1;
  font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-toolbar { position: fixed; display: none; z-index: 61; }
.sa-toolbar[data-open="1"] { display: flex; gap: 6px; }
.sa-btn { font: inherit; font-size: 12px; line-height: 1; padding: 6px 10px; cursor: pointer;
  color: var(--dsw-alias-label-primary, CanvasText); background: var(--dsw-alias-bg-layer-1, Canvas);
  border: 1px solid var(--dsw-alias-border-l2, ButtonBorder); border-radius: 7px;
  box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.sa-btn:hover { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }
/* 主题里的 brand 变量在不同配色下深浅不一，白字容易糊成一片 —— 主按钮用固定的蓝底白字。 */
.sa-btn.sa-primary { color: #fff; background: #247bbf; border-color: #247bbf; font-weight: 600; }
.sa-btn.sa-primary:hover { color: #fff; background: #1f6aa6; border-color: #1f6aa6; }
.sa-btn:disabled { opacity: .5; cursor: default; }
.sa-popover { position: fixed; display: none; z-index: 62; width: 340px; max-width: calc(100vw - 24px);
  padding: 10px; box-sizing: border-box; border-radius: 10px; color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-layer-1, Canvas); border: 1px solid var(--dsw-alias-border-l2, ButtonBorder);
  box-shadow: 0 10px 32px rgba(0,0,0,.24); }
.sa-popover[data-open="1"] { display: block; }
.sa-popover[data-mode="note"], .sa-popover[data-mode="note-edit"] { width: 300px; padding: 8px; border-radius: 12px; }
.sa-popover[data-mode="note"] .sa-pop-input, .sa-popover[data-mode="note-edit"] .sa-pop-input { min-height: 54px; border-radius: 8px; }
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
        console.log(message, ...rest)
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
        /** 输入框里每条引用块的来路（按引用正文索引）：点它写批注时把文件/消息出处带上。 */
        const quoteOrigins = new Map()
        /** 正在读原文、补引用来路坐标的引用正文（同一段只读一次）。 */
        const quoteRefines = new Set()
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
         * 同一段话在文件里出现多次时（比如都叫 `selection-annotations` 的两行），按捕获时
         * 记下的行号择优 —— 只有那一行上确实有这段原文才采用，指不到就退回第一处。
         * @param quote - 引文。
         * @param preferLine - 捕获时所在的 1 基行号（可选）。
         * @returns { start, end } 源文本里的半开区间。
         */
        function locateInSource(source, quote, preferLine) {
          const needle = quote.replace(/\s+/g, ' ').trim()
          if (needle === '') return undefined
          const hay = normalizeWithMap(source)
          const hits = []
          let from = 0
          for (;;) {
            const at = hay.text.indexOf(needle, from)
            if (at === -1 || hits.length >= 64) break
            hits.push(at)
            from = at + 1
          }
          if (hits.length === 0) return undefined
          let at = hits[0]
          if (hits.length > 1 && Number.isFinite(preferLine)) {
            const onLine = hits.find((index) => {
              const mapped = hay.map[index]
              return mapped !== undefined && lineOfOffset(source, mapped) === preferLine
            })
            if (onLine !== undefined) at = onLine
          }
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
            // 抛错绝不能无声消失：安静退回渲染坐标，控制台留一行原因。
            log(`[selection-annotations] 位置精修抛错：${error instanceof Error ? error.message : String(error)}`)
            return undefined
          }
        }

        async function resolveSourcePositionInner(source, quote, onSkip) {
          /**
           * 精修失败一律安静退回（退到渲染坐标，绝不阻断创建），但原因要有去处：
           * 控制台一行日志，另外交给 onSkip —— 插件把它显示在面板条目上。
           */
          const skip = (reason) => {
            log(`[selection-annotations] 位置精修跳过（${String(source?.path)}）：${reason}`)
            if (typeof onSkip === 'function') onSkip(reason)
            return undefined
          }
          if (source?.kind !== 'file') return undefined
          if (typeof source.path !== 'string' || source.path === '') return undefined
          const sessionId = currentSessionId()
          if (sessionId === undefined) return skip('拿不到当前会话 id')
          // 读原文要经 remote：客户端上下文只把 inject 里声明过的命名空间挂上去，
          // 所以 `remote.workspaceFiles` 必须先写进 inject（少写就取值即抛）。
          // 而 remote 本身有两种作用域 —— 会话作用域（sessions.scope().remote）与根上下文
          // （ctx.remote）—— 前者不带这个命名空间，因此逐个探测、哪个能用用哪个。
          const candidates = []
          const agent = safe(() => ctx.sessions?.scope?.(sessionId))
          if (agent?.remote !== undefined) candidates.push({ label: 'sessions.scope().remote', remote: agent.remote })
          const direct = safe(() => ctx.remote) ?? safe(() => ctx.get('remote'))
          if (direct !== undefined) candidates.push({ label: 'ctx.remote', remote: direct })
          // 探测放在 safe 里：取不到的候选会抛，而不是返回 undefined。
          let usable
          for (const entry of candidates) {
            const probe = safe(() => typeof entry.remote?.workspaceFiles?.read === 'function')
            if (probe === undefined) {
              continue
            }
            if (probe === true) {
              usable = entry
              break
            }
          }
          if (usable === undefined) {
            return skip(`拿不到 remote.workspaceFiles.read（试过 ${candidates.map((e) => e.label).join(' / ') || '无任何 remote'}）`)
          }
          log(`[selection-annotations] 位置精修：经 ${usable.label} 读 ${source.path}`)
          const outcome = await withTimeout(
            safe(() => usable.remote.workspaceFiles.read(sessionId, source.path, {})),
            SOURCE_LOOKUP_TIMEOUT_MS,
          )
          if (outcome.ok === false) return skip(`读取失败：${outcome.reason}`)
          const file = unwrapRemote(outcome.value)
          const text = typeof file?.text === 'string' ? file.text : undefined
          if (text === undefined) return skip('返回里没有 text（path 可能不被接受）')
          const hit = locateInSource(text, quote, source?.lineStart)
          if (hit === undefined) {
            return skip(
              file?.eof === false
                ? `引文不在读取窗口内（只拿到 ${text.length} 字符，eof=false）`
                : '引文不在原文里（多半是跨了行内 Markdown 标记）',
            )
          }
          return {
            charStart: hit.start,
            charEnd: hit.end,
            // 原文坐标给负载用；页面里那处高亮仍按渲染坐标找，所以原样留一份。
            ...(Number.isFinite(source?.charStart) ? { renderedCharStart: source.charStart } : {}),
            ...(Number.isFinite(source?.charEnd) ? { renderedCharEnd: source.charEnd } : {}),
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

        /**
         * 定位一条批注的当前 Range：活的 Range 优先，失效就按锚点 + 偏移重建。
         * @param item - 带 quote / source 的定位目标。
         * @param cache - 活 Range 的缓存宿主，默认就是 item 自己；引用批注会传入一个临时对象，
         *   因为它每次定位用的来源是折出来的（见 paintSourceRange），不适合挂在批注上。
         */
        function locateRange(item, cache = item) {
          if (cache.liveRange !== undefined) {
            const live = cache.liveRange
            const usable =
              safe(() => live.startContainer.isConnected === true && live.endContainer.isConnected === true) === true
            if (usable && rangeMatchesQuote(live, item.quote)) return live
            cache.liveRange = undefined
          }
          const root = anchorRoot(item.source)
          if (root === null || root === undefined) return undefined
          // 择优用的偏移必须是**渲染坐标**：charStart 升级成原文坐标后，拿它去比渲染正文只会更偏。
          const savedOffset = Number.isFinite(item.source?.renderedCharStart)
            ? item.source.renderedCharStart
            : item.source?.textOrigin === 'source'
              ? undefined
              : item.source?.charStart
          const range = matchInRoot(root, item.quote, savedOffset)
          if (range !== undefined) cache.liveRange = range
          return range
        }

        /* ------------------------------------------------------------------ 引用（composer quote） */

        /**
         * 输入框里当前所有引用块，按草稿顺序。
         *
         * 读的是 composer 投影（shell.projection.quotes），不是引用块的 DOM 文案 ——
         * 后者会把「移除」按钮的文字也算进 textContent。
         */
        function quoteEntries() {
          const shell = inputShell()
          if (shell === null || shell === undefined) return []
          const quotes = safe(() => shell.projection?.quotes)
          if (Array.isArray(quotes) !== true) return []
          return quotes.filter(
            (entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string',
          )
        }

        /** 输入框里所有引用块的宿主元素，按文档顺序 —— 与投影顺序一致。 */
        function quoteChips() {
          return [...document.querySelectorAll('[data-composer-quote]')]
        }

        /** 引用块正文开头那行来路：文件片段得让模型知道出自哪个文件的哪几行。 */
        function quoteOriginLine(source) {
          if (source === null || source === undefined) return ''
          const path = typeof source.path === 'string' && source.path !== '' ? source.path : ''
          const hasLines = Number.isFinite(source.lineStart)
          const span = hasLines
            ? Number.isFinite(source.lineEnd) && source.lineEnd !== source.lineStart
              ? `${source.lineStart}–${source.lineEnd}`
              : `${source.lineStart}`
            : ''
          if (path === '') return span === '' ? '' : `【第 ${span} 行】`
          return span === '' ? `【${path}】` : `【${path}:${span}】`
        }

        /** 引用块正文 = 可选的来路行 + 原文。 */
        function quoteBody(source, quote) {
          const text = typeof quote === 'string' ? quote : ''
          if (text === '') return ''
          const line = quoteOriginLine(source)
          return line === '' ? text : `${line}\n${text}`
        }

        /**
         * 引用块正文里的「原文」：剥掉开头那行「【path:12–18】」来路。
         *
         * 文件片段 / 消息片段的引用正文第一行是来路，正文从第二行开始；批注里的 quote 有时是
         * 带行号的整段（点引用块写下的），有时只是原文（从选区写下的）—— 比「是不是同一段」时
         * 两边都折成这个口径。
         * @param text - 引用正文或批注原文。
         */
        function quoteExcerptOf(text) {
          const body = typeof text === 'string' ? text : ''
          const index = body.indexOf('\n')
          if (index <= 0) return body
          const head = body.slice(0, index)
          return head.startsWith('【') && head.endsWith('】') ? body.slice(index + 1) : body
        }

        /**
         * 输入框里的这段引用，是不是已经有一条批注了。
         *
         * 不按来源分类：用户先给消息里的原文写批注、随后又把它「引用」进输入框，看到的仍然是
         * 同一段原文，再点引用应该编辑那条批注，而不是又添一条。但同一句话出现在两个文件里
         * 就是两回事 —— 引用正文带来路行（【path:12–18】）时，来路也要对得上才算同一条。
         * @param text - 引用块正文（可能带【path:行号】）。
         * @param source - 这段引用的出处（用来比来路；没有就只比原文）。
         */
        function annotationOnQuote(text, source) {
          const excerpt = quoteExcerptOf(text)
          if (excerpt === '') return undefined
          const line = quoteOriginLine(source)
          return annotations.find((item) => {
            if (item.quote === text) return true
            if (quoteExcerptOf(item.quote) !== excerpt) return false
            return quoteOriginLine(item.source) === line
          })
        }

        /** 往输入框插入一条引用。返回是否真的插进去了（只读/冻结态会被官方拒绝）。 */
        function insertQuote(text) {
          const body = typeof text === 'string' ? text.trim().slice(0, MAX_QUOTE) : ''
          if (body === '') return false
          const actions = latestInputActions
          if (actions === null || actions === undefined || typeof actions.insertQuote !== 'function') {
            warn('[selection-annotations] 当前输入态不支持插入引用，批注本身不受影响')
            return false
          }
          let inserted = false
          safe(() => {
            inserted = actions.insertQuote(body) === true
          })
          if (!inserted) warn('[selection-annotations] 插入引用被拒绝（输入框可能处于只读或冻结态）')
          return inserted
        }

        /** 这段文字是不是已经在输入框里引用了（同一段插两次没有意义）。 */
        function hasQuoteText(text) {
          return quoteEntries().some((entry) => entry.text === text)
        }

        /**
         * 记下某条引用块的来路，之后点它写批注时把出处带上。
         *
         * 存的是**整份来源**（含 anchorKey / 字符区间 / 预览 url）：批注落在引用上之后，
         * 还要回到原文那一处画标记 —— 只留路径与行号就不够定位消息里的那段话了。
         */
        function rememberQuoteOrigin(text, source) {
          if (typeof text !== 'string' || text === '') return
          if (source === null || source === undefined) return
          if (source.kind !== 'file' && source.kind !== 'message') return
          const origin = {}
          for (const key of ORIGIN_KEYS) {
            const value = source[key]
            if (value === undefined || value === null || value === '') continue
            origin[key] = value
          }
          origin.kind = source.kind
          quoteOrigins.set(text, origin)
          // 只留最近几十条：这层只是点引用块时的提示，不是真相来源。
          while (quoteOrigins.size > 40) {
            const oldest = quoteOrigins.keys().next()
            if (oldest.done === true) break
            quoteOrigins.delete(oldest.value)
          }
          refineQuoteOrigin(text, origin)
        }

        /**
         * 文件引用的来路补正：插入时量到的是**渲染坐标**，这里再折算成原文坐标。
         *
         * 我们自己的契约是「工作区文件但凡能读到原文就给 source」。引用是从预览里量出来的，
         * 只有渲染后正文的偏移（Markdown 预览的行号还会与原文错开），所以插入之后异步读一次
         * 源文件补上 charStart/charEnd/lineStart/lineEnd。读不到、或引文跨了行内标记，就静默
         * 留在渲染坐标 —— 引用与批注本身都不受影响。
         *
         * @param text - 引用块正文（可能带【path:行号】来路行）。
         * @param origin - 记在 quoteOrigins 里的那份来路（原地补字段）。
         */
        function refineQuoteOrigin(text, origin) {
          if (origin === null || origin === undefined) return
          if (origin.kind !== 'file') return
          if (typeof origin.path !== 'string' || origin.path === '') return
          if (origin.textOrigin === 'source') return
          if (quoteRefines.has(text)) return
          const excerpt = quoteExcerptOf(text)
          if (excerpt === '') return
          quoteRefines.add(text)
          const task = (async () => {
            const precise = await safe(() =>
              resolveSourcePosition(
                {
                  kind: 'file',
                  path: origin.path,
                  lineStart: origin.lineStart,
                  charStart: origin.renderedCharStart ?? origin.charStart,
                  charEnd: origin.renderedCharEnd ?? origin.charEnd,
                },
                excerpt,
              ),
            )
            if (precise === undefined) return
            // 这段引用可能已经被删掉、或又插了一条同文的：只认当初记下的那一份。
            if (quoteOrigins.get(text) !== origin) return
            const existing = annotationOnQuote(text, quoteAnnotationSource(text, origin))
            Object.assign(origin, precise)
            quoteOrigins.set(text, origin)
            if (existing !== undefined) {
              annotations = annotations.map((item) =>
                item.id === existing.id ? { ...item, source: { ...item.source, ...precise } } : item,
              )
              emit()
              if (annotations.length > 0) scheduleSync()
            }
            scheduleRepaint()
          })()
          const done = () => quoteRefines.delete(text)
          void task.then(done, (err) => {
            done()
            warn('[selection-annotations] 引用来路补正失败（不影响引用）：', err)
          })
        }

        /** 把一条引用块变成批注目标：引用原文 + 可选的来路（字段原样带过来）。 */
        function quoteAnnotationSource(text, origin) {
          const source = { kind: 'quote', text }
          if (origin === null || origin === undefined) return source
          for (const key of ORIGIN_KEYS) {
            const value = origin[key]
            if (value === undefined || value === null || value === '') continue
            source[key] = value
          }
          if (origin.kind === 'file' || origin.kind === 'message') source.from = origin.kind
          return source
        }

        /** 找一条引用批注对应的引用块：记过的元素优先，其次按引用文本对齐投影顺序。 */
        /** 引用被移除时，连同挂在它上面的批注一起忘掉（引用和批注是同一条记录的两种形态）。 */
        function forgetQuoteAnnotation(text) {
          if (typeof text !== 'string' || text === '') return
          const origin = quoteOrigins.get(text)
          const existing = annotationOnQuote(text, quoteAnnotationSource(text, origin))
          quoteOrigins.delete(text)
          if (existing !== undefined) removeAnnotation(existing.id)
          else scheduleRepaint()
        }

        function quoteChipOf(item) {
          const remembered = item?.quoteAnchor
          if (remembered !== null && remembered !== undefined && remembered.isConnected === true) return remembered
          const chips = quoteChips()
          if (chips.length === 0) return null
          const entries = quoteEntries()
          const wanted = typeof item?.quote === 'string' ? item.quote : ''
          if (wanted !== '' && entries.length === chips.length) {
            const exact = entries.findIndex((entry) => entry.text === wanted)
            // 批注存的是原文，引用块正文可能带着「【path:行号】」来路行：整段对不上就按原文对。
            const index = exact >= 0 ? exact : entries.findIndex((entry) => quoteExcerptOf(entry.text) === quoteExcerptOf(wanted))
            if (index >= 0 && chips[index] !== undefined) return chips[index]
          }
          return null
        }

        /**
         * 批注 → 引用：把这条批注的原文也插进输入框，作为它的引用块。
         *
         * 用户要的是「批注落在引用上」：引用负责把原文摆到模型眼前，批注块负责说明要改什么。
         * 插入可能被输入态拒绝（冻结/只读），那也不影响批注本身 —— 只是这条没有引用块可挂。
         */
        function attachQuoteToAnnotation(item, quote, source) {
          if (item === null || item === undefined) return
          const body = quoteBody(source, quote)
          if (body === '') return
          const already = hasQuoteText(body)
          if (!already) {
            // 这条引用是批注流程自己插的：别再弹一次批注输入框。
            suppressQuotePrompt += 1
            if (!insertQuote(body)) {
              suppressQuotePrompt -= 1
              return
            }
            rememberQuoteOrigin(body, source)
          }
          annotations = annotations.map((entry) => (entry.id === item.id ? { ...entry, viaQuote: true } : entry))
          emit()
          scheduleSync()
          scheduleRepaint()
        }

        /**
         * 把草稿里那张「批注.json」卡片藏起来。
         *
         * 它只是把批注送进宿主的信道（原生文件附件），不是给人看的东西 —— 用户看到的批注就是
         * 输入框里那条引用块。不能摘掉附件（摘了宿主就收不到批注），只隐藏；批注清空时由
         * 附件同步自然摘掉。已发消息里的同名附件卡片不动（那是历史，也可能是用户自己传的）。
         */
        function hidePayloadCards() {
          for (const marked of document.querySelectorAll('[data-sa-payload]')) {
            safe(() => marked.removeAttribute('data-sa-payload'))
          }
          for (const card of document.querySelectorAll(`[title="${ANNOTATION_FILE}"]`)) {
            const element = elementOf(card)
            if (element === null) continue
            if (element.closest('[data-composer-card]') === null) continue
            // 卡片外面还套着一层轨道条目：只藏卡片会留下空隙，能一起藏就一起藏。
            const holder = element.parentElement
            const host = holder !== null && holder.childNodes.length === 1 ? holder : element
            safe(() => host.setAttribute('data-sa-payload', '1'))
          }
        }

        /** 给引用块挂上「点击写批注」的提示。只挂一次，热重绘时不会反复写属性。 */
        function decorateQuoteChips() {
          // 编号由 repaint 重新打：上一轮留下的必须先清掉，否则删掉批注后下划线还在。
          for (const marked of document.querySelectorAll('[data-sa-number]')) {
            safe(() => marked.removeAttribute('data-sa-number'))
          }
          for (const chip of quoteChips()) {
            if (chip.getAttribute('data-sa-quote') === '1') continue
            safe(() => {
              chip.setAttribute('data-sa-quote', '1')
              chip.setAttribute('title', '点击为这条引用写批注')
            })
          }
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
            quoteAnchor: input.quoteAnchor,
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
          if (source.kind === 'quote') {
            const line = quoteOriginLine(source)
            return line === '' ? '输入框引用' : `输入框引用 ${line}`
          }
          return '页面选区'
        }

        /**
         * 负载条目：**输入框里每一条引用都是一条记录**，写了描述的只是多了 note。
         *
         * 编号与界面角标同源（第 i 条引用就是第 i+1 号），所以模型看到的 index 与用户看到的
         * 数字对得上 —— 用户说「4 条引用 3 个批注」时，数据块里就是 4 条记录、3 条带 note。
         * 输入框里已经没有对应引用的批注（消息发出后、或那条引用被删了）接在后面继续编号。
         */
        function payloadItems() {
          const entries = quoteEntries()
          const items = []
          const seen = new Set()
          for (let index = 0; index < entries.length; index += 1) {
            const text = entries[index].text
            const fallback = quoteAnnotationSource(text, quoteOrigins.get(text))
            const item = annotationOnQuote(text, fallback)
            if (item !== undefined) seen.add(item.id)
            items.push({
              number: index + 1,
              quote: quoteExcerptOf(text),
              note: item?.note ?? '',
              source: item?.source ?? fallback,
            })
          }
          let extra = entries.length
          for (const item of annotations) {
            if (seen.has(item.id)) continue
            extra += 1
            items.push({
              number: extra,
              quote: quoteExcerptOf(item.quote),
              note: item.note,
              source: item.source,
            })
          }
          return items
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
                '若某条的 source.kind 是 "quote"，表示用户是在输入框的引用块上写下的这条批注：' +
                'source.text 就是那条引用的原文（它同时也以 Markdown 引用块出现在用户消息正文里），' +
                'source.path + lineStart/lineEnd 是这段原文的文件出处，source.anchorKey + charStart/charEnd 是它在对话消息里的位置，' +
                'source.from 说明它来自文件还是对话。' +
                '这类批注不必再复述一遍引用内容，直接按批注要求处理即可。' +
                'annotations 按用户界面上的编号排列：index 就是用户在引用块、以及原文处的编号角标上看到的那个序号，' +
                '第 i 条引用就是第 i 号；接口里出现 note 为空字符串的条目，表示这段原文只是被引用、用户没有写描述，' +
                '除非用户正文另有要求，不必专门回应它（count 是条目总数，described 是有描述的条数）。' +
                '请按 index 逐条对照回应。',
              count: items.length,
              described: items.filter((item) => typeof item.note === 'string' && item.note.trim() !== '').length,
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
          } else if (source?.kind === 'quote') {
            if (typeof source.text === 'string' && source.text !== '') out.text = source.text
            if (typeof source.path === 'string' && source.path !== '') out.path = source.path
            if (Number.isFinite(source.lineStart)) out.lineStart = source.lineStart
            if (Number.isFinite(source.lineEnd)) out.lineEnd = source.lineEnd
            if (source.from === 'file' || source.from === 'message') out.from = source.from
            if (typeof source.role === 'string' && source.role !== '') out.role = source.role
            if (typeof source.anchorKey === 'string' && source.anchorKey !== '') out.anchorKey = source.anchorKey
          }
          if (out.kind === 'file' || out.kind === 'message') {
            out.textOrigin = source?.textOrigin === 'source' ? 'source' : 'rendered'
          } else if (out.kind === 'quote' && (source?.textOrigin === 'source' || source?.textOrigin === 'rendered')) {
            out.textOrigin = source.textOrigin
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

        /** 立刻同步，不等防抖：点别处提交批注后马上就要发消息时，不能让附件还停在旧内容上。 */
        function flushSync() {
          if (syncTimer === null) return
          window.clearTimeout(syncTimer)
          syncTimer = null
          void syncAttachment()
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

            // 负载按「引用」而不是「批注」计数：只有描述的那些是多出来的 note，
            // 这样数据块里的条数、编号都与界面上看到的一致。
            const items = payloadItems()
            const file = new File([buildPayload(items)], ANNOTATION_FILE, { type: 'application/json' })
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
            const described = items.filter((item) => item.note !== '').length
            log(`[selection-annotations] 批注块已挂到本条消息（${items.length} 条引用，其中 ${described} 条有描述）`)
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
          hidePayloadCards()
          decorateQuoteChips()
          const entries = quoteEntries()
          const chips = quoteChips()
          // 引用和批注是同一样东西：输入框里第 i 条引用就是第 i+1 个标记，
          // 「批注」只是这条引用多写了一段描述 —— 所以编号必须由引用决定，而不是谁先创建。
          const numbered = new Set()
          for (let index = 0; index < entries.length; index += 1) {
            const text = entries[index].text
            const fallback = quoteAnnotationSource(text, quoteOrigins.get(text))
            const item = annotationOnQuote(text, fallback)
            if (item !== undefined) numbered.add(item.id)
            const excerpt = quoteExcerptOf(text)
            const source = quoteSourceAnchor({ quote: text, source: item?.source ?? fallback })
            if (source !== undefined) {
              paintSourceRange(
                {
                  id: item?.id ?? null,
                  number: index + 1,
                  quote: excerpt,
                  note: item?.note ?? '',
                  chip: chips[index] ?? null,
                },
                source,
                excerpt,
              )
            }
            // 引用批注也要回到原文那一处：只在引用块上画下划线，等于把「批注在说什么」锁死在输入框里。
            if (item !== undefined) paintQuoteMark(item, index + 1)
          }
          // 输入框里已经没有对应引用的批注（消息发出后、或那条引用被删了）：排在所有引用后面继续编号。
          let extra = entries.length
          for (const item of annotations) {
            if (numbered.has(item.id)) continue
            extra += 1
            if (item.source?.kind === 'quote') {
              paintQuoteMark(item, extra)
              paintQuoteSource(item, extra)
              continue
            }
            paintSourceRange({ ...item, number: extra }, item.source, item.quote)
          }
        }

        /**
         * 在原文处画标记：高亮块 + 首块上的编号角标。
         * @param item - 归属的批注（角标点击要回到它）。
         * @param source - 定位来源。
         * @param quote - 要标出来的原文。
         */
        function paintSourceRange(item, source, quote) {
          const range = locateRange({ id: item.id, source, quote })
          if (range === undefined) return
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
              // 右上角：贴在高亮块的右端上方，不压住文字。
              badge.style.left = `${rect.right - 12}px`
              badge.style.top = `${rect.top - 9}px`
              badge.title = item.note === '' ? item.quote : `${item.quote}\n\n批注：${item.note}`
              badge.addEventListener('click', (event) => {
                event.preventDefault()
                event.stopPropagation()
                // 正文批注：改它自己。纯引用：回到输入框里那条引用上写描述。
                if (typeof item.id === 'string') {
                  openEditPopover(item.id, badge)
                  return
                }
                const chip = item.chip ?? quoteChips()[item.number - 1]
                if (chip === null || chip === undefined) return
                openQuoteNote(chip, safe(() => badge.getBoundingClientRect()))
              })
              overlay.appendChild(badge)
            }
          }
        }

        /**
         * 引用批注的定位源。
         *
         * 引用记录里带着来路（anchorKey / 预览 url / 字符区间）。可也有两种记录不带来的：
         * 早期版本只留了 path 与行号；或者这条引用是从草稿恢复、从别处粘进输入框的。
         * 那就按原文在页面上把它找回来 —— 先找消息行，再找文件预览。
         */
        function quoteSourceAnchor(item) {
          const source = item?.source ?? {}
          const excerpt = quoteExcerptOf(item?.quote)
          if (excerpt === '') return undefined
          if (typeof source.anchorKey === 'string' && source.anchorKey !== '') {
            return {
              kind: 'message',
              anchorKey: source.anchorKey,
              role: source.role,
              flowKind: source.flowKind,
              charStart: source.charStart,
              charEnd: source.charEnd,
              // 渲染坐标要一起带过来，否则重复原文只能取第一处。
              ...(Number.isFinite(source.renderedCharStart) ? { renderedCharStart: source.renderedCharStart } : {}),
              ...(Number.isFinite(source.renderedCharEnd) ? { renderedCharEnd: source.renderedCharEnd } : {}),
            }
          }
          if (typeof source.sourceUrl === 'string' && source.sourceUrl !== '') {
            return {
              kind: 'file',
              sourceUrl: source.sourceUrl,
              path: source.path,
              lineStart: source.lineStart,
              lineEnd: source.lineEnd,
              charStart: source.charStart,
              charEnd: source.charEnd,
              // charStart 补正后是原文坐标，页面里那处高亮要靠渲染坐标择优 —— 丢了就会退回首处。
              ...(Number.isFinite(source.renderedCharStart) ? { renderedCharStart: source.renderedCharStart } : {}),
              ...(Number.isFinite(source.renderedCharEnd) ? { renderedCharEnd: source.renderedCharEnd } : {}),
              textOrigin: 'source',
            }
          }
          return inferQuoteSource(excerpt)
        }

        /** 没有来路时，按原文在页面里找回它出现的锚点：消息行优先，其次文件预览。 */
        function inferQuoteSource(excerpt) {
          if (typeof excerpt !== 'string' || excerpt === '') return undefined
          for (const row of [...document.querySelectorAll('[data-chat-anchor-key]')]) {
            const at = (row.textContent ?? '').indexOf(excerpt)
            if (at === -1) continue
            const flowKind = row.getAttribute('data-chat-flow-kind') ?? undefined
            return {
              kind: 'message',
              anchorKey: row.getAttribute('data-chat-anchor-key') ?? undefined,
              flowKind,
              role: flowKind === 'user' || flowKind === 'steering' ? 'user' : 'assistant',
              charStart: at,
              charEnd: at + excerpt.length,
            }
          }
          for (const doc of [...document.querySelectorAll('[data-textpreview-url]')]) {
            const at = (doc.textContent ?? '').indexOf(excerpt)
            if (at === -1) continue
            const sourceUrl = doc.getAttribute('data-textpreview-url') ?? undefined
            return {
              kind: 'file',
              sourceUrl,
              path: sourceUrl === undefined ? undefined : pathFromPreviewUrl(sourceUrl),
              charStart: at,
              charEnd: at + excerpt.length,
              textOrigin: 'rendered',
            }
          }
          return undefined
        }

        /** 引用批注在原文处的标记：定位源折出来才能画。 */
        function paintQuoteSource(item, number) {
          const source = quoteSourceAnchor(item)
          if (source === undefined) return
          paintSourceRange({ ...item, number: number ?? item.number }, source, quoteExcerptOf(item.quote))
        }

        /**
         * 引用批注的标记：**不自绘任何浮层**。
         *
         * 引用块自己就是官方的气泡（悬浮显示全文 + 移除按钮），我们再叠一个虚线框和角标只会打架。
         * 这里只给引用原文的 [data-quote-preview] 打上编号，CSS 负责画下划线；点引用块进批注。
         * @param item - 引用来源的批注。
         */
        function paintQuoteMark(item, number) {
          const chip = quoteChipOf(item)
          if (chip === null) return
          safe(() => {
            const preview = chip.querySelector('[data-quote-preview]') ?? chip
            preview.setAttribute('data-sa-number', String(number ?? item.number))
          })
        }

        /* ------------------------------------------------------------------ 选区工具条 */

        const toolbar = document.createElement('div')
        toolbar.className = 'sa-toolbar'
        toolbar.setAttribute('data-sa-ui', 'toolbar')
        // 「引用」和「批注」并排：前者只把原文搬进输入框，后者才带批注块。
        const quoteButton = document.createElement('button')
        quoteButton.type = 'button'
        quoteButton.className = 'sa-btn'
        quoteButton.textContent = '引用'
        toolbar.appendChild(quoteButton)
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
        popSave.className = 'sa-btn sa-primary'
        popSave.textContent = '确认'
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

        /** 官方「引用文本」按钮的本地化文案；认不出来时退回「气泡里只有一个按钮」。 */
        const QUOTE_LABELS = new Set([
          '引用文本',
          'Quote text',
          'テキストを引用',
          'Texto de cotización',
          'Texte de citation',
          'Zitattext',
          'Текст цитаты',
          'Citação de texto',
        ])

        function isOfficialQuoteButton(button) {
          const label = (button.getAttribute('aria-label') ?? '').trim()
          if (QUOTE_LABELS.has(label)) return true
          const surface = button.closest('[data-text-interaction-surface]')
          if (surface === null) return false
          // 认不出的语言：官方气泡目前只有一个动作，那就当它是「引用文本」。
          return surface.querySelectorAll('button').length === 1
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
            // 对话消息里的选区交给官方「引用文本」气泡：我们再并排弹一个按钮只会打架。
            const startEl = elementOf(selection.range.startContainer)
            if (startEl !== null && startEl.closest('[data-chat-anchor-key]') !== null) {
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
          const noteMode = options.mode === 'note' || options.mode === 'note-edit'
          popover.dataset.mode = options.mode
          popTitle.textContent = noteMode ? '' : options.title
          popTitle.style.display = noteMode ? 'none' : ''
          popQuote.textContent = options.quote.length > 400 ? `${options.quote.slice(0, 400)}…` : options.quote
          // 引用块自己就把原文摆明白了（悬浮卡还能看全文），批注框里再复述一遍只是噪音。
          popQuote.style.display = noteMode || options.quote === '' ? 'none' : ''
          popSource.textContent = options.sourceText
          popSource.style.display =
            noteMode && (options.sourceText === '' || options.sourceText === '输入框引用') ? 'none' : ''
          popInput.value = options.note
          popInput.placeholder = noteMode ? '添加可选评论…' : '写点什么（可以留空，只标记原文）'
          popoverMode = options.mode
          popoverTargetId = options.targetId ?? null
          popDelete.style.display = options.mode === 'edit' ? '' : 'none'
          // 引用批注：新建时「跳过」就是点别处（不建批注）；已经有批注时，那个位置给「删除批注」。
          if (noteMode) {
            const canDelete = options.mode === 'note-edit'
            popCancel.style.display = canDelete ? '' : 'none'
            // 「清空」只清描述，引用本身还在（引用＝标记，描述＝批注）；整条删掉要用引用块上的「移除」。
            popCancel.textContent = canDelete ? '清空' : '取消'
            popCancel.title = canDelete ? '清空这段描述，引用会留下' : ''
            popCancel.dataset.action = canDelete ? 'delete' : 'cancel'
          } else {
            popCancel.style.display = ''
            popCancel.textContent = '取消'
            popCancel.dataset.action = 'cancel'
          }
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

        /** 把当前选区作为引用插进输入框（文件选区会带上路径/行号）。 */
        function createQuoteFromSelection() {
          const selection = pendingSelection
          if (selection === null) return
          const source = captureSource(selection.range)
          const body = quoteBody(source, selection.quote).trim()
          // 先把原文的位置量下来：插进输入框之后 DOM 变了，这里就量不准了。
          const rect = safe(() => selection.range.getBoundingClientRect())
          hideToolbar()
          if (body === '') return
          if (!insertQuote(body)) return
          lastQuoteRect = rect ?? null
          rememberQuoteOrigin(body, source)
          safe(() => window.getSelection()?.removeAllRanges())
          scheduleRepaint()
        }

        /**
         * 给输入框里的一条引用写批注。
         *
         * 不弹自己的引用气泡（那是官方引用块 + 悬浮全文卡的事），只弹一个输入框；
         * 留空关掉就等于「只引用、不批注」，不会留下任何批注记录。
         * @param chip - 被点的（或刚插入的）[data-composer-quote] 元素。
         * @param rect - 弹框该贴哪儿：插入引用时用原文选区的位置，点引用块时用引用块的位置。
         */
        function openQuoteNote(chip, rect) {
          // 上一个框里已经写了字：先落成批注，再开这一个。
          if (popover.dataset.open === '1') dismissPopover()
          const chips = quoteChips()
          const index = chips.indexOf(chip)
          if (index < 0) return
          const entry = quoteEntries()[index]
          const text = typeof entry?.text === 'string' ? entry.text : ''
          if (text === '') return
          const fallbackSource = quoteAnnotationSource(text, quoteOrigins.get(text))
          // 这条引用之前已经有批注（哪怕是从正文选区写下的）就编辑那一条，别再添一条。
          const existing = annotationOnQuote(text, fallbackSource)
          const source = existing?.source ?? fallbackSource
          popoverAnchor = existing === undefined ? { quote: text, source, range: null, chip } : null
          showPopover({
            title: '',
            quote: '',
            sourceText: describeSource(source),
            note: existing?.note ?? '',
            rect: rect ?? safe(() => chip.getBoundingClientRect()),
            mode: existing === undefined ? 'note' : 'note-edit',
            targetId: existing?.id ?? null,
          })
        }

        /* ------------------------------------- 插入引用后，自动弹出批注输入 */

        /** 输入框里当前引用的文本序列（投影顺序）。 */
        function quoteTexts() {
          return quoteEntries().map((entry) => entry.text)
        }

        /** 每条引用出现了几次：按次数比对才能分清「新插一条」和「删掉中间一条」。 */
        function quoteCounts() {
          const counts = new Map()
          for (const text of quoteTexts()) counts.set(text, (counts.get(text) ?? 0) + 1)
          return counts
        }

        let knownQuotes = new Map()
        let quoteWatchTimer = null
        let lastQuoteGestureAt = 0
        /** 批注流程自己插的引用：不该再把批注框弹回用户脸上。 */
        let suppressQuotePrompt = 0
        /** 每块 composer 第一次见到的引用只当基线，不当成「刚插入」。 */
        const bootstrappedComposers = new WeakSet()
        /** 刚插入的那条引用的原文位置：批注框要贴在这儿，而不是贴在输入框里的引用块上。 */
        let lastQuoteRect = null

        /**
         * 把「已经在那儿」的 composer 全部记成基线。
         *
         * 以前只在见到新引用时才把 composer 记进 bootstrappedComposers —— 于是空输入框的第一次插入
         * 永远被当成基线，批注框一次也弹不出来。基线该按 composer 的挂载时机算，而不是按引用出现的时机算。
         */
        function bootstrapComposers() {
          for (const root of document.querySelectorAll('[data-composer-card],[data-composer-input]')) {
            bootstrappedComposers.add(root)
          }
        }

        function composerRootOf(node) {
          const element = elementOf(node)
          if (element === null) return null
          return element.closest('[data-composer-card],[data-composer-input]') ?? null
        }

        /**
         * 引用块是 Lexical 自己渲染的，拦不到 insertQuote 调用，只能看 DOM。
         *
         * 三条护栏：①只认比上一轮多出来的引用；②必须刚有过用户手势（切换会话/恢复草稿也会
         * 改 DOM，但那不是「刚插了一条引用」）；③每块 composer 第一次看到时只记基线、不弹框。
         * @returns 卸载函数。
         */
        function watchInsertedQuotes() {
          knownQuotes = quoteCounts()
          bootstrapComposers()
          const observer = new MutationObserver(() => {
            // 新挂上来的 composer（发完消息、切会话）先记基线，免得它自带的引用被当成刚插入。
            bootstrapComposers()
            if (quoteWatchTimer !== null) return
            quoteWatchTimer = window.setTimeout(() => {
              quoteWatchTimer = null
              promptForInsertedQuote()
            }, QUOTE_PROMPT_MS)
          })
          observer.observe(document.body, { childList: true, subtree: true })
          return () => observer.disconnect()
        }

        function promptForInsertedQuote() {
          const texts = quoteTexts()
          const counts = quoteCounts()
          // 负载里每条引用都是一条记录、而且编号由引用顺序决定 —— 引用集合一变（增、删、换序），
          // 已经发出去的那份批注块就跟界面对不上了，重发一份。
          const changed =
            counts.size !== knownQuotes.size ||
            [...counts].some(([text, count]) => knownQuotes.get(text) !== count)
          let addedText = null
          for (const [text, count] of counts) {
            if (count > (knownQuotes.get(text) ?? 0)) addedText = text
          }
          knownQuotes = counts
          if (changed && annotations.length > 0) scheduleSync()
          if (addedText === null) return
          if (suppressQuotePrompt > 0) {
            suppressQuotePrompt -= 1
            return
          }
          if (Date.now() - lastQuoteGestureAt > QUOTE_GESTURE_MS) return
          const chip = quoteChips()[texts.lastIndexOf(addedText)]
          if (chip === undefined) return
          const root = composerRootOf(chip)
          // 兜底：真的遇到一块没记过基线的 composer，就静默这一次，别把恢复出来的草稿当新插入。
          if (root !== null && bootstrappedComposers.has(root) !== true) {
            bootstrappedComposers.add(root)
            return
          }
          if (popover.dataset.open === '1') return
          const rect = lastQuoteRect
          lastQuoteRect = null
          // 原文那一刻不在视口里（比如刚滚过）就退回引用块，别把框顶到屏幕边缘。
          const visible =
            rect !== undefined &&
            rect !== null &&
            rect.width > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight
          openQuoteNote(chip, visible ? rect : undefined)
        }
        /**
         * 修改一条既有批注。
         * 这是编号角标点击后的默认行为 —— 点它是要改这一条，不是打开列表。
         * @param id - 目标批注 id。
         * @param anchor - 用来定位弹层的元素（角标或列表里的「编辑」按钮）。
         */
        function openEditPopover(id, anchor) {
          if (popover.dataset.open === '1') dismissPopover()
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
         * 点别处把批注框关掉。
         *
         * 框里已经写了字，就**当成已经写下的批注**，不必非得按「确认」——用户写下的东西不该因为
         * 少按一次按钮而丢掉。空框关掉仍然是「只引用、不批注」；Esc 依旧当取消，不提交。
         */
        function dismissPopover() {
          if ((popoverMode === 'note' || popoverMode === 'note-edit') && popInput.value.trim() !== '') {
            commitQuoteNote()
            flushSync()
            return
          }
          closePopover()
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
          // 原因只显示在面板里、不进载荷，所以不需要为此重传附件。
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

        /**
         * 引用批注最终记下的来源：能补的来路尽量补上。
         *
         * 一条引用若没带来路（早期记录、粘贴进来的、草稿恢复的），批注就标不回原文。
         * 这里按原文在页面上找回它一次，找到就把定位字段写进 source，下次重绘直接可用。
         */
        function quoteSourceFor(quote, source) {
          const base = source ?? { kind: 'quote', text: quote }
          if (base.kind !== 'quote') return base
          const carriesAnchor =
            (typeof base.anchorKey === 'string' && base.anchorKey !== '') ||
            (typeof base.sourceUrl === 'string' && base.sourceUrl !== '')
          if (carriesAnchor) return base
          const inferred = inferQuoteSource(quoteExcerptOf(quote))
          if (inferred === undefined) return base
          const merged = { ...base }
          for (const key of ORIGIN_KEYS) {
            const value = inferred[key]
            if (value === undefined || value === null || value === '') continue
            merged[key] = value
          }
          merged.from = inferred.kind
          return merged
        }

        /**
         * 提交引用上的批注。
         *
         * 新建时留空等于「没写」——引用留着、批注不建（和点别处跳过同一个结果）。
         * 改已有的批注时留空只是「不改」，撤掉要用弹层里的「删除」，免得清空输入框就丢数据。
         */
        function commitQuoteNote() {
          const anchor = popoverAnchor
          const target = popoverTargetId
          const note = popInput.value.trim()
          closePopover()
          if (target !== null) {
            if (note !== '') updateAnnotation(target, note)
            return
          }
          if (anchor === null || note === '') return
          const source = quoteSourceFor(anchor.quote, anchor.source)
          addAnnotation({ quote: anchor.quote, note, source, quoteAnchor: anchor.chip ?? undefined })
        }

        function commitPopover() {
          if (popoverMode === 'note' || popoverMode === 'note-edit') {
            commitQuoteNote()
            return
          }
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
          // 同一段原文（同一来路）已经有一条批注：这次当成编辑它，否则引用块上会叠出两条。
          const duplicate = annotationOnQuote(quoteBody(anchor.source, anchor.quote), anchor.source)
          if (duplicate !== undefined) {
            if (note !== '') updateAnnotation(duplicate.id, note)
            attachQuoteToAnnotation(duplicate, anchor.quote, anchor.source)
            return
          }
          // 先创建：这一段绝不能依赖任何可能失败的东西。
          const created = addAnnotation({
            quote: anchor.quote,
            note,
            source: anchor.source,
            liveRange: anchor.range ?? undefined,
            quoteAnchor: anchor.chip ?? undefined,
          })
          safe(() => window.getSelection()?.removeAllRanges())
          if (created === undefined) return
          // 引用批注：引用块已经在输入框里了，不必再插一条，也没有渲染坐标可精修。
          if (anchor.source?.kind === 'quote') {
            scheduleRepaint()
            return
          }
          // 正文批注：顺带把原文插成引用块，让这条批注真的落在引用上。
          attachQuoteToAnnotation(created, anchor.quote, anchor.source)
          // 再异步把位置精修到原文坐标；失败只记日志。
          refineSourcePosition(created.id, anchor.source, anchor.quote).catch((err) => {
            warn('[selection-annotations] 位置精修失败（不影响这条批注）：', err)
          })
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
        quoteButton.addEventListener('mousedown', (event) => {
          // 同样要保住选区：插引用用的就是这段选区。
          event.preventDefault()
        })
        quoteButton.addEventListener('click', (event) => {
          event.preventDefault()
          createQuoteFromSelection()
        })

        // 引用块在 Lexical 的 contenteditable 里：用捕获阶段接点击，别让编辑器先移走光标。
        // 引用块自带「移除」按钮，点它要放行 —— 否则就删不掉这条引用了。
        document.addEventListener(
          'click',
          (event) => {
            const target = elementOf(event.target)
            if (target === null) return
            const chip = target.closest('[data-composer-quote]')
            if (chip === null) return
            if (target.closest('button') !== null) {
              // 官方「移除」把引用整条删掉：引用即标记，标记没了它的批注也不能留在正文里。
              forgetQuoteAnnotation(quoteEntries()[quoteChips().indexOf(chip)]?.text)
              return
            }
            event.preventDefault()
            event.stopPropagation()
            openQuoteNote(chip)
          },
          true,
        )
        popCancel.addEventListener('click', () => {
          // 引用批注改到一半不要了：这个位置删掉的只能是批注本身，引用块留在输入框里。
          if (popCancel.dataset.action === 'delete') {
            deleteFromPopover()
            return
          }
          closePopover()
        })
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
          dismissPopover()
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
          if (source?.kind === 'quote') {
            if (typeof source.path === 'string' && source.path !== '') {
              const where = Number.isFinite(source.lineStart) ? `${source.path}:${source.lineStart}` : source.path
              return `引用 · ${where}`
            }
            return '输入框引用'
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
            panelEl.appendChild(
              el('div', 'sa-hint', '选中回复、消息或文件预览里的文字，点浮动「批注」或「引用」；点输入框里的引用也能直接批注。'),
            )
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
            // 引用来源的原文带着「【path:行号】」来路行，面板里只显示原文，出处由上面的摘要负责。
            const shownQuote = item.source?.kind === 'quote' ? quoteExcerptOf(item.quote) : item.quote
            if (shownQuote !== '') row.appendChild(el('div', 'sa-item-quote', shownQuote))
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
          foot.appendChild(el('span', 'sa-hint', '发送时批注作为独立块随消息提交，原文以引用块随正文发出'))
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
          const stopQuoteWatch = watchInsertedQuotes()
          // 只有「刚有过用户手势」的新增引用才弹批注框，避免切换会话时对恢复的草稿误弹。
          const onQuoteGesture = () => {
            lastQuoteGestureAt = Date.now()
          }
          window.addEventListener('pointerup', onQuoteGesture, true)
          window.addEventListener('keyup', onQuoteGesture, true)
          /**
           * 接管官方「引用文本」按钮：外观仍是官方气泡，插入走我们自己的流程。
           *
           * 官方那条动作只做 insertQuote(text)，不记出处 —— 于是「在引用上写的批注」永远标不回原文。
           * 这里在捕获阶段截住点击，换成 captureSource + rememberQuoteOrigin，再收起官方浮层。
           */
          const onQuoteActionClick = (event) => {
            const target = elementOf(event.target)
            if (target === null) return
            const button = target.closest('[data-text-interaction-surface] button')
            if (button === null || button.closest('[data-sa-ui]') !== null) return
            if (!isOfficialQuoteButton(button)) return
            const selection = readSelection()
            if (selection === null) return
            // 插入能力不在时把点击还给官方：否则我们吞掉了点击却什么也没插进去。
            const actions = latestInputActions
            if (actions === null || actions === undefined || typeof actions.insertQuote !== 'function') return
            event.preventDefault()
            event.stopPropagation()
            const source = captureSource(selection.range)
            const body = quoteBody(source, selection.quote).trim()
            const rect = safe(() => selection.range.getBoundingClientRect())
            if (body === '' || !insertQuote(body)) return
            lastQuoteRect = rect ?? null
            rememberQuoteOrigin(body, source)
            lastQuoteGestureAt = Date.now()
            safe(() => window.getSelection()?.removeAllRanges())
            scheduleRepaint()
          }
          document.addEventListener('click', onQuoteActionClick, true)
          return () => {
            document.removeEventListener('selectionchange', onSelectionChange)
            window.removeEventListener('scroll', onViewport, true)
            window.removeEventListener('resize', onViewport)
            window.removeEventListener('pointerup', onQuoteGesture, true)
            window.removeEventListener('keyup', onQuoteGesture, true)
            document.removeEventListener('click', onQuoteActionClick, true)
            observer.disconnect()
            stopQuoteWatch()
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
          payload: () => buildPayload(payloadItems()),
          receipt: () => draftIds[0] ?? null,
          drafts: () => [...draftIds],
          session: () => currentSessionId(),
          quotes: () => quoteEntries().map((entry) => entry.text),
          insertQuote: (text) => insertQuote(text),
          rememberQuoteOrigin: (text, source) => rememberQuoteOrigin(text, source),
          quoteOrigin: (text) => quoteOrigins.get(text),
          repaint,
          remove: removeAnnotation,
          clear: clearAnnotations,
          update: (id, note) => updateAnnotation(id, note),
          add: (input) => addAnnotation(input),
          _internals: { buildPayload, payloadItems, payloadSource, describeSource, captureSource, matchInRoot, locateRange, rangeFromOffsets, offsetRange, anchorRoot, locateInSource, lineOfOffset, resolveSourcePosition, refineSourcePosition, quoteBody, quoteOriginLine, quoteExcerptOf, annotationOnQuote, quoteAnnotationSource, quoteSourceAnchor, inferQuoteSource, quoteSourceFor, refineQuoteOrigin },
        }
      },
    }
  },
})
