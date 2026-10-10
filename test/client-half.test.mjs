/**
 * 客户端半边测试台：在 Node 里给 client.js 造一个够用的最小 DOM / React / Cordis 环境，
 * 把「批注集合 → 批注报告 → 运行时草稿附件 → 挂进输入态 → 发送后被消费清空」整条数据通路跑通。
 *
 * 它验证的是**逻辑**，不是渲染：真实的选区几何、高亮位置需要在浏览器里看。
 * 运行：node --import ./test/loader.mjs --test test/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ 最小 DOM */

const node = (text) => ({ nodeType: 3, nodeValue: text, parentElement: null, isConnected: true })

function element(tag, attrs = {}, children = []) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentElement: null,
    isConnected: true,
    style: {},
    dataset: {},
    attributes: new Map(Object.entries(attrs)),
    className: '',
    value: '',
    type: '',
    offsetWidth: 120,
    offsetHeight: 30,
    appendChild(child) {
      el.childNodes.push(child)
      child.parentElement = el
      return child
    },
    append(...items) {
      for (const item of items) el.appendChild(item)
    },
    remove() {
      const parent = el.parentElement
      if (parent !== null) parent.childNodes = parent.childNodes.filter((candidate) => candidate !== el)
    },
    setAttribute(key, value) {
      el.attributes.set(key, String(value))
    },
    getAttribute(key) {
      return el.attributes.has(key) ? el.attributes.get(key) : null
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    contains(other) {
      if (other === el) return true
      return flatten(el).includes(other)
    },
    closest(selector) {
      let current = el
      while (current !== null && current !== undefined) {
        if (matches(current, selector)) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector) {
      const found = []
      const visit = (node) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeType !== 1) continue
          if (matches(child, selector)) found.push(child)
          visit(child)
        }
      }
      visit(el)
      return found
    },
  }
  for (const child of children) el.appendChild(child)
  // textContent 必须是真的读写器：插件用读它做锚点匹配，用写它清空/填入节点。
  Object.defineProperty(el, 'textContent', {
    get: () => textOf(el),
    set: (value) => {
      el.childNodes = []
      const text = String(value)
      if (text !== '') el.appendChild({ nodeType: 3, nodeValue: text, parentElement: el, isConnected: true })
    },
  })
  return el
}

/** 只支持本插件实际用到的那几个选择器形状。 */
function matches(el, selector) {
  if (el === null || el.nodeType !== 1) return false
  for (const part of selector.split(',')) {
    const candidate = part.trim()
    const attrMatch = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(candidate)
    if (attrMatch !== null) {
      const value = el.getAttribute(attrMatch[1])
      if (value === null) continue
      if (attrMatch[2] === undefined || value === attrMatch[2]) return true
      continue
    }
    if (/^\.[A-Za-z0-9_-]+$/.test(candidate)) {
      if (String(el.className).split(/\s+/).includes(candidate.slice(1))) return true
      continue
    }
    if (/^(input|textarea)$/i.test(candidate) && el.tagName === candidate.toUpperCase()) return true
    if (/^[a-z]+$/i.test(candidate) && el.tagName === candidate.toUpperCase()) return true
  }
  return false
}

const flatten = (root, out = []) => {
  if (root.nodeType === 3) {
    out.push(root)
    return out
  }
  for (const child of root.childNodes ?? []) flatten(child, out)
  return out
}
const textOf = (root) => flatten(root).map((n) => n.nodeValue ?? '').join('')

/** 把 (node, offset) 折算成根内的一维字符位置。 */
function positionOf(root, target, offset) {
  if (target === null) return -1
  if (target.nodeType === 1) {
    const inner = flatten(target)
    return inner.length === 0 ? 0 : positionOf(root, inner[0], 0)
  }
  let position = 0
  for (const candidate of flatten(root)) {
    if (candidate === target) return position + offset
    position += (candidate.nodeValue ?? '').length
  }
  return -1
}

function makeEnvironment() {
  let rangeRoot = null

  class FakeRange {
    constructor() {
      this.startContainer = null
      this.endContainer = null
      this.startOffset = 0
      this.endOffset = 0
    }
    setStart(target, offset) {
      this.startContainer = target
      this.startOffset = offset
      return this
    }
    setEnd(target, offset) {
      this.endContainer = target
      this.endOffset = offset
      return this
    }
    cloneRange() {
      const copy = new FakeRange()
      return copy.setStart(this.startContainer, this.startOffset).setEnd(this.endContainer, this.endOffset)
    }
    toString() {
      if (rangeRoot === null) return ''
      const from = positionOf(rangeRoot, this.startContainer, this.startOffset)
      const to = positionOf(rangeRoot, this.endContainer, this.endOffset)
      if (from < 0 || to < 0 || to < from) return ''
      return textOf(rangeRoot).slice(from, to)
    }
    getClientRects() {
      return []
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 }
    }
  }

  const head = element('head')
  const body = element('body')
  const listeners = new Map()

  const document = {
    head,
    body,
    createElement: (tag) => element(tag),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    createRange: () => new FakeRange(),
    createTreeWalker: (root) => {
      const nodes = flatten(root).filter((candidate) => candidate.nodeType === 3)
      let index = -1
      return {
        nextNode() {
          index += 1
          return index < nodes.length ? nodes[index] : null
        },
      }
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  const loaded = []
  const window = {
    __ModuleLoader__: { load: (mod) => loaded.push(mod) },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
    getSelection: () => ({ rangeCount: 0, isCollapsed: true, getRangeAt: () => null, removeAllRanges() {} }),
  }

  const require = (name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }

  return {
    document,
    window,
    require,
    loaded,
    listeners,
    element,
    node,
    setRangeRoot(root) {
      rangeRoot = root
    },
  }
}

/** 载入 client.js（它只调用 window.__ModuleLoader__.load，不会立刻执行副作用）。 */
function loadBundle(env) {
  const factory = new Function(
    'window',
    'document',
    'MutationObserver',
    'TextEncoder',
    'btoa',
    'console',
    'AbortController',
    'NodeFilter',
    SOURCE,
  )
  factory(
    env.window,
    env.document,
    class {
      observe() {}
      disconnect() {}
    },
    TextEncoder,
    btoa,
    { log() {}, warn() {}, error() {} },
    AbortController,
    { SHOW_TEXT: 4 },
  )
  assert.equal(env.loaded.length, 1, 'bundle 必须注册恰好一个模块')
  assert.equal(env.loaded[0].id, '@u2a5f/dsh-selection-annotations', 'bundle id 必须与包名逐字一致')
  return env.loaded[0].factory(env.require)
}

/** 极简 snapshot store，形状与 dsh-client-store 的 createSnapshotStore 一致。 */
function createStore(initial) {
  let value = initial
  const subscribers = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    set(next) {
      value = next
      for (const fn of [...subscribers]) fn()
    },
  }
}

/**
 * 组装最小 ctx + 可观测的 conversation 运行时。
 *
 * 关键：`createDrafts` / `addFiles` / `releaseDraftAttachment` / `fileUploads` 就是
 * dsh-client-ui-conversation 官方附件链路的形状（拖拽/粘贴附件走的那条）。
 */
function makeHarness(options = {}) {
  const env = makeEnvironment()
  const mod = loadBundle(env)

  const uploads = []
  const released = []
  const registrations = []
  const draftAttachments = new Map()
  let draftSeq = 0

  const fileUploads = createStore({})
  let inputSnapshot = { draft: '', attachmentIds: [] }
  const inputSubscribers = new Set()
  const publish = () => {
    for (const fn of [...inputSubscribers]) fn()
  }

  const shell = {
    state: {
      getSnapshot: () => inputSnapshot,
      subscribe(fn) {
        inputSubscribers.add(fn)
        return () => inputSubscribers.delete(fn)
      },
    },
    addFiles(references, ids) {
      inputSnapshot = { ...inputSnapshot, attachmentIds: [...inputSnapshot.attachmentIds, ...ids] }
      publish()
      return true
    },
    removeAttachment(id) {
      inputSnapshot = { ...inputSnapshot, attachmentIds: inputSnapshot.attachmentIds.filter((x) => x !== id) }
      publish()
      return true
    },
  }

  const conversation = {
    input: { for: () => (options.noScope === true ? undefined : shell) },
    fileUploads,
    createDrafts(sessionId, files) {
      return files.map((file) => {
        draftSeq += 1
        const id = `d${draftSeq}`
        draftAttachments.set(id, { kind: 'file', id, file })
        uploads.push({ sessionId, file })
        fileUploads.set({ ...fileUploads.getSnapshot(), [id]: { status: 'uploading' } })
        setTimeout(() => {
          if (options.uploadFails === true) {
            fileUploads.set({ ...fileUploads.getSnapshot(), [id]: { status: 'error', message: '上传失败' } })
            return
          }
          fileUploads.set({
            ...fileUploads.getSnapshot(),
            [id]: { status: 'ready', receiptId: `r-${id}`, file: { attachmentId: `a-${id}`, name: file.name, bytes: file.size } },
          })
        }, options.uploadDelayMs ?? 0)
        return { kind: 'file', id }
      })
    },
    releaseDraftAttachment(id) {
      released.push(id)
      draftAttachments.delete(id)
      const next = { ...fileUploads.getSnapshot() }
      delete next[id]
      fileUploads.set(next)
    },
  }

  if (options.noRuntime === true) delete conversation.createDrafts

  /** 模拟消息发出：草稿与附件一起被 composer 清掉。 */
  const send = () => {
    inputSnapshot = { draft: '', attachmentIds: [] }
    publish()
  }

  const ctx = {
    get(name) {
      if (name === 'uiSession' && options.noSession !== true) {
        return { adapter: { current: { getSnapshot: () => ({ key: options.sessionId ?? 's1' }) } } }
      }
      return undefined
    },
    effect(callback) {
      callback()
      return () => {}
    },
    on() {
      return () => {}
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(opts, Component) {
        registrations.push({ opts, Component })
        return () => {}
      },
    },
    sessions: {
      scope: () => (options.noScope === true ? undefined : {}),
      list: { getSnapshot: () => ({ current: options.sessionId ?? 's1' }) },
    },
    conversation,
  }

  mod.apply(ctx)

  return {
    env,
    mod,
    ctx,
    uploads,
    released,
    registrations,
    shell,
    conversation,
    fileUploads,
    inputState: () => inputSnapshot,
    send,
    debug: env.window.__dshSelectionAnnotations,
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => wait(700)
const payloadTextOf = (upload) => upload.file.text()
const payloadOf = async (upload) => JSON.parse(await payloadTextOf(upload))

/* ------------------------------------------------------------------ 用例 */

test('apply 之后：悬挂 UI 建成、批注按钮注册进发送按钮旁的槽位', () => {
  const harness = makeHarness()
  assert.equal(harness.registrations.length, 1)
  assert.equal(harness.registrations[0].opts.name, 'conversation.input.right', '必须在发送按钮旁的紧凑控件槽位')
  assert.equal(harness.registrations[0].opts.id, 'selection-annotations')
  assert.equal(typeof harness.registrations[0].Component, 'function')
  assert.equal(harness.env.document.body.childNodes.length, 4, '覆盖层 / 工具条 / 批注弹层 / 悬浮面板都要挂上')

  const ui = harness.env.document.head.childNodes[0]
  assert.equal(ui.tagName, 'STYLE')
  assert.ok(ui.textContent.includes('--dsw-alias-brand-primary'), '样式必须使用主题 token')
  assert.ok(ui.textContent.includes('rgb(255 208 66'), '高亮必须是淡黄色叠加')
})

test('批注负载是自描述的 JSON 数据块，位置用行号 + 字符区间表达', () => {
  const harness = makeHarness()
  const { buildPayload } = harness.debug._internals

  const payload = JSON.parse(
    buildPayload([
      {
        number: 1,
        quote: '这里为什么用 `Arc`？',
        note: '觉得可以省掉',
        source: { kind: 'message', role: 'assistant', anchorKey: 'k1', flowKind: 'assistant-step', charStart: 40, charEnd: 52 },
      },
      {
        number: 2,
        quote: 'let x = 1;',
        note: '',
        source: { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18, charStart: 100, charEnd: 110 },
      },
    ]),
  )

  assert.equal(payload.kind, 'dsh-selection-annotations', 'kind 是宿主认领的依据')
  assert.equal(payload.version, 1)
  assert.equal(payload.count, 2)
  assert.equal(typeof payload.instruction, 'string', '数据块要自描述')
  assert.equal(payload.annotations.length, 2)

  const [first, second] = payload.annotations
  assert.equal(first.index, 1)
  assert.equal(first.quote, '这里为什么用 `Arc`？')
  assert.equal(first.note, '觉得可以省掉')
  assert.deepEqual(first.source, {
    kind: 'message',
    role: 'assistant',
    anchorKey: 'k1',
    flowKind: 'assistant-step',
    charStart: 40,
    charEnd: 52,
  })

  assert.equal(second.index, 2)
  assert.deepEqual(second.source, { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18, charStart: 100, charEnd: 110 })
})

test('位置字段缺省时不会往 JSON 里塞 null 噪声', () => {
  const harness = makeHarness()
  const { payloadSource } = harness.debug._internals
  assert.deepEqual(payloadSource({ kind: 'file', path: 'a.ts' }), { kind: 'file', path: 'a.ts' })
  assert.deepEqual(payloadSource({ kind: 'message', flowKind: 'user', charStart: 0, charEnd: 3 }), {
    kind: 'message',
    role: 'user',
    flowKind: 'user',
    charStart: 0,
    charEnd: 3,
  })
  assert.deepEqual(payloadSource(undefined), { kind: 'dom' })
})

test('批注集合 → 运行时草稿附件 → 挂进输入态（官方 createDrafts/addFiles 链路）', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: '被引用的原文', note: '这条有问题', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })

  await settle()

  assert.equal(harness.uploads.length, 1, '应当只登记一次草稿附件')
  assert.equal(harness.uploads[0].sessionId, 's1')
  assert.equal(harness.uploads[0].file.name, '批注.json', '负载以 JSON 文件形式随消息提交')
  const payload = await payloadOf(harness.uploads[0])
  assert.equal(payload.annotations[0].quote, '被引用的原文')
  assert.equal(payload.annotations[0].note, '这条有问题')

  const drafts = harness.debug.drafts()
  assert.equal(drafts.length, 1, '必须让运行时登记草稿附件，而不是只塞 id')
  assert.deepEqual(harness.inputState().attachmentIds, drafts, '附件必须挂进输入态')
})

test('不在上传就绪前挂载：否则 sendSession 会整条消息抛错', async () => {
  const harness = makeHarness({ uploadDelayMs: 150 })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  // 防抖 450ms 之后才开始登记；上传还要 150ms 才 ready。
  await wait(520)
  assert.equal(harness.uploads.length, 1, '草稿附件应当已登记')
  assert.equal(harness.debug.drafts().length, 0, '还没 ready 就不该挂进输入态')

  await wait(400)
  assert.equal(harness.debug.drafts().length, 1, 'ready 之后才挂上')
})

test('上传失败时不挂载，也不留下半截状态', async () => {
  const harness = makeHarness({ uploadFails: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  await settle()

  assert.equal(harness.debug.drafts().length, 0)
  assert.deepEqual(harness.inputState().attachmentIds, [])
  assert.deepEqual(harness.released, ['d1'], '失败的草稿附件必须释放掉')
  assert.equal(harness.debug.list().length, 1, '批注本身仍留在插件里')
})

test('消息发出（附件被消费）后自动清空，不会黏到下一条消息', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })
  await settle()
  assert.equal(harness.debug.list().length, 1)

  harness.send()
  await wait(30)
  assert.equal(harness.debug.list().length, 0, '附件被消费后批注应视为已送达')
  assert.deepEqual(harness.debug.drafts(), [])
})

test('还没确认挂上之前，输入态抖动不会误清批注', async () => {
  const harness = makeHarness({ uploadDelayMs: 200 })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  harness.send() // 此时附件还没挂上
  await settle()

  assert.equal(harness.debug.list().length, 1, '批注必须还在')
  assert.equal(harness.debug.drafts().length, 1, '随后仍应正常挂上')
})

test('追加减批注只保留一个附件：旧的会被摘掉', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  harness.debug.add({ quote: 'b', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()

  assert.equal(harness.uploads.length, 2)
  assert.deepEqual(harness.released, ['d1'], '旧附件必须摘掉，避免一条消息挂两份批注块')
  assert.deepEqual(harness.inputState().attachmentIds, ['d2'])
  const second = await payloadOf(harness.uploads[1])
  assert.equal(second.count, 2, '第二版负载应含两条批注')
  assert.equal(second.annotations[1].quote, 'b')
})

test('清空批注会把附件摘下来', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  harness.debug.clear()
  await settle()

  assert.deepEqual(harness.inputState().attachmentIds, [])
  assert.deepEqual(harness.released, ['d1'])
  assert.deepEqual(harness.debug.drafts(), [])
})

test('空选区空批注不会产生批注条目', () => {
  const harness = makeHarness()
  assert.equal(harness.debug.add({ quote: '', note: '', source: { kind: 'message' } }), undefined)
  assert.equal(harness.debug.add({ quote: '   ', note: '   ', source: { kind: 'dom' } }), undefined)
  assert.equal(harness.debug.list().length, 0)
})

test('删除批注后编号重新连续', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  harness.debug.add({ quote: 'b', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  harness.debug.add({ quote: 'c', note: '', source: { kind: 'message', anchorKey: 'k1' } })

  harness.debug.remove(harness.debug.list()[1].id)
  await settle()

  assert.deepEqual(
    harness.debug.list().map((item) => [item.number, item.quote]),
    [
      [1, 'a'],
      [2, 'c'],
    ],
    '编号必须跟着顺序重排',
  )
})

test('修改批注：只改批注文字，原文与出处不变，并重新生成附件', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: '原文', note: '初稿', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })
  await settle()

  const id = harness.debug.list()[0].id
  harness.debug.update(id, '改过的批注')
  await settle()

  const item = harness.debug.list()[0]
  assert.equal(item.note, '改过的批注')
  assert.equal(item.quote, '原文', '原文不得被编辑改变')
  assert.equal(item.source.anchorKey, 'k1', '出处不得被编辑改变')
  assert.equal(harness.uploads.length, 2, '修改后必须重新生成附件')
  assert.equal((await payloadOf(harness.uploads[1])).annotations[0].note, '改过的批注')
  assert.deepEqual(harness.released, ['d1'], '旧附件要摘掉')
})

test('拿不到会话 scope 时安静降级，不登记也不抛错', async () => {
  const harness = makeHarness({ noScope: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.uploads.length, 0, '没有输入外壳就不该登记草稿附件')
  assert.equal(harness.debug.list().length, 1, '批注本身仍要留在插件里')
})

test('运行时没有 createDrafts 时只告警、不抛错', async () => {
  const harness = makeHarness({ noRuntime: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.uploads.length, 0)
  assert.deepEqual(harness.debug.drafts(), [])
  assert.equal(harness.debug.list().length, 1)
})

test('锚点重建：按字符偏移在文本节点间切出准确的 Range', () => {
  const harness = makeHarness()
  const { rangeFromOffsets } = harness.debug._internals

  const first = harness.env.node('前缀 ')
  const middle = harness.env.node('目标原文')
  const last = harness.env.node(' 后缀')
  const root = harness.env.element('div', {}, [first, middle, last])
  harness.env.setRangeRoot(root)

  const range = rangeFromOffsets(root, 3, 4)
  assert.ok(range !== undefined, '应当能按偏移重建 Range')
  assert.equal(range.toString(), '目标原文')
})

test('锚点重建：重复片段按保存时的偏移择优', () => {
  const harness = makeHarness()
  const { rangeFromOffsets, matchInRoot } = harness.debug._internals

  const root = harness.env.element('div', {}, [harness.env.node('foo bar foo baz foo')])
  harness.env.setRangeRoot(root)

  assert.equal(matchInRoot(root, 'foo', 0).toString(), 'foo')
  assert.equal(matchInRoot(root, 'foo', 8).toString(), 'foo')
  assert.equal(rangeFromOffsets(root, 8, 3).toString(), 'foo')
  assert.equal(matchInRoot(root, '不存在的片段', 0), undefined)
})

test('出处捕获：代码预览没有行号属性，按 .line 序号推算行号', () => {
  const harness = makeHarness()
  const { captureSource } = harness.debug._internals

  const makeLine = (text) => {
    const line = harness.env.element('div', {}, [harness.env.node(text)])
    line.className = 'line'
    return line
  }
  const first = makeLine('line one')
  const second = makeLine('line two')
  const third = makeLine('line three')
  const pre = harness.env.element('pre', {}, [first, second, third])
  const code = harness.env.element('div', { 'data-code-preview': '' }, [pre])
  const text = third.childNodes[0]
  harness.env.setRangeRoot(code)
  const range = harness.env.document.createRange().setStart(text, 5).setEnd(text, 8)

  const source = captureSource(range)
  assert.equal(source.kind, 'file')
  assert.equal(source.lineStart, 3, '应当是第三条 .line')
  assert.equal(source.lineEnd, 3)
  assert.equal(source.charStart, 'line one'.length + 'line two'.length + 5)
  assert.equal(source.charEnd, 'line one'.length + 'line two'.length + 8)
})

test('出处捕获：助手消息锚点 + 文件路径与行号', () => {
  const harness = makeHarness()
  const { captureSource } = harness.debug._internals

  const text = harness.env.node('hello world')
  const row = harness.env.element('div', { 'data-chat-anchor-key': 'k7', 'data-chat-flow-kind': 'assistant-step' }, [text])
  harness.env.setRangeRoot(row)
  const range = harness.env.document.createRange().setStart(text, 0).setEnd(text, 5)

  const source = captureSource(range)
  assert.equal(source.kind, 'message')
  assert.equal(source.anchorKey, 'k7')
  assert.equal(source.flowKind, 'assistant-step')
  assert.equal(source.charStart, 0)
  assert.equal(source.charEnd, 5)

  const line = harness.env.element('div', { 'data-textpreview-line': '12' }, [harness.env.node('let x = 1;')])
  const pre = harness.env.element('div', { 'data-textpreview-url': 'dsh-resource://file/session/s1/src%2Fa.ts' }, [line])
  const lineText = line.childNodes[0]
  harness.env.setRangeRoot(pre)
  const fileRange = harness.env.document.createRange().setStart(lineText, 4).setEnd(lineText, 9)

  const fileSource = captureSource(fileRange)
  assert.equal(fileSource.kind, 'file')
  assert.equal(fileSource.path, 'src/a.ts', '路径必须从 data-textpreview-url 解出来')
  assert.equal(fileSource.lineStart, 12)
  assert.equal(fileSource.charStart, 4)
  assert.equal(fileSource.charEnd, 9)
})
