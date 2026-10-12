/**
 * 宿主半边冒烟测试：验证「摘掉批注 JSON 块 + 追加独立 JSON 消息」的确切行为。
 * 运行：node --import ./test/loader.mjs --test test/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

const FILE_NAME = '批注.json'

const PAYLOAD = {
  kind: 'dsh-selection-annotations',
  version: 1,
  instruction: '这是用户随上一条消息附加的批注数据块……',
  count: 1,
  annotations: [
    {
      index: 1,
      quote: '设计要点',
      note: '这里有歧义',
      source: { kind: 'file', path: 'a.ts', lineStart: 3, lineEnd: 4, charStart: 10, charEnd: 14 },
    },
  ],
}
const REPORT = JSON.stringify(PAYLOAD, null, 2)

/** 组装一个只提供 pre-step 事件与假附件服务的 ctx。 */
function makeCtx(files, config) {
  let preStep
  const ctx = {
    on(name, handler) {
      if (name === 'agent/pre-step') preStep = handler
    },
    get(key) {
      if (key !== 'attachments') return undefined
      return {
        async *readFileStream(ref) {
          const text = files[ref.attachmentId]
          if (text === undefined) throw new Error(`no such attachment: ${ref.attachmentId}`)
          yield new TextEncoder().encode(text)
        },
      }
    },
  }
  apply(ctx, config)
  assert.ok(typeof preStep === 'function', 'apply 必须注册 agent/pre-step')
  return preStep
}

/** 用给定的 messages 跑一次 pre-step。 */
async function run(messages, files = {}, config = undefined) {
  const preStep = makeCtx(files, config)
  const next = async () => ({ kind: 'enter', messages })
  return preStep({ signal: undefined }, next)
}

const fileBlock = (attachmentId, name = FILE_NAME) => ({ type: 'file', attachment: { attachmentId, name, bytes: 100 } })
const userMessage = (content) => ({ id: 'm1', role: 'user', content, source: { kind: 'user', rpcId: 'r1' } })

test('正文 + 批注 JSON 块 → 正文单独一条，批注另起一条独立消息', async () => {
  const decision = await run([userMessage([{ type: 'text', text: '这段为什么这么写？' }, fileBlock('a1')])], { a1: REPORT })

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)

  const [direct, sidecar] = decision.messages
  assert.deepEqual(direct.content, [{ type: 'text', text: '这段为什么这么写？' }])
  assert.equal(direct.source.kind, 'user')

  assert.equal(sidecar.role, 'user')
  assert.equal(sidecar.source.kind, 'annotation')
  assert.equal(sidecar.source.count, 1)
  assert.equal(sidecar.content.length, 1)
  assert.notEqual(sidecar.id, direct.id, '独立消息必须有自己的 id')

  // 独立消息的正文必须就是那份 JSON 数据块本身。
  const forwarded = JSON.parse(sidecar.content[0].text)
  assert.equal(forwarded.kind, 'dsh-selection-annotations')
  assert.equal(forwarded.annotations[0].quote, '设计要点')
  assert.equal(forwarded.annotations[0].source.lineStart, 3)
  assert.equal(forwarded.annotations[0].source.charStart, 10)
  assert.equal(forwarded.annotations[0].source.charEnd, 14)
})

test('没有批注附件时原样放行（同一个对象，不做无谓复制）', async () => {
  const message = userMessage([{ type: 'text', text: '你好' }])
  const decision = await run([message])
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message)
})

test('同名但不是批注负载的文件不得被误摘', async () => {
  const message = userMessage([{ type: 'text', text: '看下附件' }, fileBlock('a2')])
  const decision = await run([message], { a2: '{"hello":"world"}' })

  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message, '整条消息应原样保留')
  assert.equal(decision.messages[0].content.length, 2, '文件块必须还在')
})

test('非 JSON 内容（哪怕扩展名是 .json）不得被误摘', async () => {
  const message = userMessage([{ type: 'text', text: 'q' }, fileBlock('a3')])
  const decision = await run([message], { a3: '{"kind":"something-else","annotations":[]}' })
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message)
})

test('文件名被改过也能按内容认领（认领依据是 JSON，不是文件名）', async () => {
  const decision = await run(
    [userMessage([{ type: 'text', text: 'q' }, fileBlock('a4', 'renamed-payload.json')])],
    { a4: REPORT },
  )
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.kind, 'annotation')
})

test('扩展名不是 .json 时不做候选，不读取也不认领', async () => {
  const message = userMessage([{ type: 'text', text: 'q' }, fileBlock('a5', '批注.txt')])
  const decision = await run([message], { a5: REPORT })
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message)
})

test('附件读取失败时降级为不认领，不抛错', async () => {
  const message = userMessage([{ type: 'text', text: '你好' }, fileBlock('missing')])
  const decision = await run([message], {})
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message)
})

test('只有批注附件、没有正文时，丢弃空壳消息只留批注消息', async () => {
  const decision = await run([userMessage([fileBlock('a6')])], { a6: REPORT })
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, 'annotation')
})

test('非 user 来源的消息不被处理（防止处理我们自己追加的批注消息）', async () => {
  const message = { id: 'x', role: 'user', content: [{ type: 'text', text: 'r' }, fileBlock('a1')], source: { kind: 'annotation' } }
  const decision = await run([message], { a1: REPORT })
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0], message)
})

test('同一份批注块被挂了两遍时只算一份（附件被 restore 回去又挂一次）', async () => {
  const decision = await run(
    [userMessage([{ type: 'text', text: 'q' }, fileBlock('a1'), fileBlock('a2')])],
    { a1: REPORT, a2: REPORT },
  )
  assert.equal(decision.messages.length, 2, '正文一条 + 批注一条，不该多出第二条批注')
  const forwarded = JSON.parse(decision.messages[1].content[0].text)
  assert.equal(forwarded.count, 1, '两份一模一样的内容只保留一份')
})

test('多个批注附件会被合并成一份数据块，index 重新连续', async () => {
  const second = JSON.stringify({ ...PAYLOAD, count: 1, annotations: [{ ...PAYLOAD.annotations[0], index: 1, quote: '第二处' }] })
  const decision = await run(
    [userMessage([{ type: 'text', text: 'q' }, fileBlock('a1'), fileBlock('a2')])],
    { a1: REPORT, a2: second },
  )
  assert.equal(decision.messages.length, 2)
  const forwarded = JSON.parse(decision.messages[1].content[0].text)
  assert.equal(forwarded.count, 2)
  assert.deepEqual(
    forwarded.annotations.map((item) => item.index),
    [1, 2],
  )
  assert.equal(forwarded.annotations[1].quote, '第二处')
})

test('下游 reject 决策原样透传', async () => {
  const preStep = makeCtx({})
  const decision = await preStep({ signal: undefined }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

test('Config：超过 maxPayloadBytes 的负载视为无效，整条消息原样放行', async () => {
  const big = JSON.stringify({ ...PAYLOAD, annotations: [{ ...PAYLOAD.annotations[0], note: 'x'.repeat(4000) }] })
  const message = userMessage([{ type: 'text', text: 'q' }, fileBlock('a1')])
  const decision = await run([message], { a1: big }, { maxPayloadBytes: 1024 })
  assert.equal(decision.messages.length, 1, '超限不该伪造出批注消息')
  assert.equal(decision.messages[0], message, '文件块也不该被摘掉')
})

test('Config：非法 maxPayloadBytes 回落到默认值而不是报错', async () => {
  const message = userMessage([{ type: 'text', text: 'q' }, fileBlock('a1')])
  const decision = await run([message], { a1: REPORT }, { maxPayloadBytes: -5 })
  assert.equal(decision.messages.length, 2, '回落默认上限后应当正常认领')
})
