# dsh-selection-annotations

[English](README.md) · [简体中文](README.zh-CN.md)

> Select text anywhere in the DSH Web UI — an assistant reply, a workspace file, a message from
> an earlier conversation — leave a note, and send the whole set with your next message as a
> **separate, machine-readable JSON block**. Your message text is never touched.
>
> Annotations can also live on the composer's **quotes**: turn a selection into a quote in one
> click and the note input opens by itself — click anywhere else to skip it and you simply get a
> quote. Quoting a
> selection inside a file preview carries the path and line numbers along, so the model knows
> exactly where the excerpt came from. DSH's own "quote text" action is taken over too: same
> bubble, but the plugin records where the excerpt came from, so a note on a quote can also be
> marked back at its source.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Zero dependencies,
zero changes to DSH itself.

## Why not just append the notes to the prompt?

The obvious way to ship "select text → annotate" in a chat UI is to append the annotation block
to the composer draft at submit time, then hide it again in the rendered bubble. It looks right,
but the model still receives **one** text block with your notes glued into your prose, and your
bubble is rewritten by a DOM script after the fact.

This plugin puts the annotations on the message as a real content block instead:

| | draft-text injection | **this plugin** |
|---|---|---|
| message `content` | `[{type:'text'}]` | `[{type:'text'}, {type:'file'}]` |
| what the model receives | your prose with notes inline | your text, **then a separate JSON message** |
| your own bubble | rewritten post-send | untouched |
| position data | free-form text | `lineStart/lineEnd`, `charStart/charEnd`, `anchorKey` |

## Features

| Feature | Detail |
|---|---|
| Select to annotate | Assistant replies, user messages, and workspace file previews. The note may be empty — that just marks the quote. |
| **Quote a selection** | The toolbar's "引用" button turns the selection into a composer quote through the official `inputActions.insertQuote` — it only moves the text, no annotation is created. Selections inside a file preview carry a `【path:12–18】` provenance line. |
| **Inserting a quote asks for a note** | Inserting a quote opens the note input right away, anchored at the quoted text itself (the rect is measured before insertion, not at the composer chip). Placeholder "添加可选评论…", a single "确认" button. Type a line and the note lands on that quote; **typing alone is enough** — clicking elsewhere commits what you typed (no need to press "确认"); closing an empty box is the skip — the quote stays and no annotation is created. DSH's own "引用文本" action on a message selection takes the same path — the plugin takes over that button: the bubble stays native, only the insertion becomes ours (so the provenance is recorded). |
| **Quotes carry a source mark by default** | The moment a quote lands in the composer, its source excerpt gets a highlight + numbered badge — **even before any note exists** (this is what Codex does). The number is the quote's position in the composer; a note is just extra description on that quote, so quote and note share one number. |
| **Click a quote to annotate** | Clicking a quote in the composer writes (or edits) its annotation. The quote *is* the UI: a blue underline plus a number on the excerpt, and the popover only asks for the note — it never repeats the text, which the native quote hover-card already shows. When the quote already has a note, "清空" sits right next to "保存" — it clears the description and leaves the quote. Creating an annotation on page text also inserts its excerpt as a quote, so the note really sits on a quote. |
| **Quote notes mark their source too** | Besides the underline on the quote, a quote note is also drawn at the source excerpt (the message row it came from, or an open file preview) with the usual highlight + numbered badge. If a quote carries no provenance (older records, pasted text, restored drafts) the plugin finds the excerpt in the page and writes the location into `source` when the note is saved. |
| **One note per excerpt** | Quote an excerpt that is already annotated, click it, and you edit *that* annotation instead of stacking a second one. Different provenance (file path + lines) counts as a different excerpt. |
| Highlight + numbered badge | Page annotations (messages and file previews) get a light-yellow overlay plus a numbered badge, anchored on semantic `data-*` attributes. Re-located after scroll or re-render by character range + quote context. |
| **Click the badge to edit** | Clicking a badge opens *that* annotation for editing; if the quote has no note yet, the badge is how you give it one. The list panel has the same entry point. |
| **Removing a quote removes its mark** | Removing the quote from the composer takes its source mark — and the note attached to it — with it, so no badge is left pointing at nothing. |
| Precise positions | Every annotation records `charStart`/`charEnd` (half-open) plus the workspace-relative `path` and 1-based `lineStart`/`lineEnd` for file sources. Coordinates are resolved against the **original file** whenever it can be read — which is also where Markdown previews get their line numbers — and fall back to rendered-DOM coordinates otherwise; `source.textOrigin` says which. |
| Trigger next to Send | Registered into `conversation.input.right`, so it occupies one compact control slot and never disturbs the composer layout. |
| Floating panel | The "批注 ×N" panel is plain DOM appended to `body` with `position: fixed` — it is completely out of flow and never pushes the input box around. |
| Sent as a separate block | The annotation set is packed into a `File` (`批注.json`) and handed to the runtime's own `createDrafts` + the input shell's `addFiles` — the exact path drag-and-drop attachments use. It is attached only once the upload reports `ready`, and its attachment card is **hidden** in the composer (`[data-sa-payload]`): it is only a channel, so what the user sees is the quote itself. |
| Separate message for the model | The host half strips that file block from the model-visible content during `agent/pre-step` and appends an independent user message whose body is the JSON. |
| Consumed on send | Once the attachment is consumed (or manually removed), the set clears — it never sticks to the next message. |

## Payload format

The model receives one extra message whose entire body is a self-describing JSON block:

```json
{
  "kind": "dsh-selection-annotations",
  "version": 1,
  "instruction": "This is an annotation block sent by the user. It is independent of the user's message text: they may have sent text alongside it, or only this block — in which case the block is the entire message. annotations[].quote is the text the user selected; annotations[].source gives its position ...",
  "count": 2,
  "described": 1,
  "annotations": [
    {
      "index": 1,
      "quote": "设计要点",
      "note": "测试批注",
      "source": {
        "kind": "file",
        "path": "dsh-selection-annotations/client.js",
        "lineStart": 4,
        "lineEnd": 4,
        "charStart": 126,
        "charEnd": 130,
        "textOrigin": "source"
      }
    },
    {
      "index": 2,
      "quote": "另一半职责是",
      "note": "",
      "source": {
        "kind": "message",
        "role": "assistant",
        "anchorKey": "14:assistant-step6:12",
        "flowKind": "assistant-step",
        "charStart": 40,
        "charEnd": 46,
        "textOrigin": "rendered"
      }
    }
  ]
}
```

Notes on the contract:

- **JSON, not prose.** Positions are things a program consumes — line numbers, character
  ranges, anchor keys. Structured fields do not get lost in natural language.
- `charStart`/`charEnd` is a **half-open range** `[charStart, charEnd)`. Which text it indexes is
  declared by `source.textOrigin`: `"source"` means offsets into the **file's own text**, so they
  can be applied to the file directly; `"rendered"` means offsets into the rendered DOM text of
  the anchor element. A hit in the file requires the plugin to read it and find the quote there,
  so it falls back to `"rendered"` when the file is unreadable or the quote straddles inline
  Markdown markup. A quote can repeat; a character range cannot.
- `lineStart`/`lineEnd` are **1-based** and only present for workspace file sources.
- `source.kind` is one of `"message"`, `"file"`, `"dom"` — or `"quote"` when the note was written
  on a composer quote: `source.text` is that quote's text (it also appears in the message body as a
  Markdown blockquote), `path` / `lineStart` / `lineEnd` give the file provenance,
  `anchorKey` / `charStart` / `charEnd` give its place in the conversation message, and `from` says
  whether the quote came from a file or a conversation.
- **One quote is one record**: `annotations` covers **every quote** in the composer — a quote
  with no note is still there, with `note: ""`. `index` is the number drawn on the badge in the UI
  (4 quotes with 3 notes = 4 records, `count: 4`, `described: 3`), so "item N" means the same thing
  to the model and to the user. Adding, removing or reordering quotes re-sends the payload, so the
  numbering never lags behind the composer.
- The host claims the payload **by content**: the parsed JSON must carry
  `kind: "dsh-selection-annotations"`. The file name is only a cheap pre-filter, so renaming the
  attachment still works.
- Multiple annotation attachments are merged into one block and `index` is renumbered `1..N`
  (`described` then keeps the first block's value; the entries themselves are unaffected).

## Install

```sh
dsh plugin --profile <profile> add @u2a5f/dsh-selection-annotations
```

Or install the directory directly with DSH's plugin manager:

```
plugin_manager  action: install_bundle  target: <absolute path to this directory>
```

Installing with `link:` from a source checkout is how this plugin is developed — see
[Development](#development).

## How it works

```
selection ──▶ annotation { quote, source, note }
                    │
                    ├─ locally: page text -> highlight + numbered badge + panel
                    │           composer quote -> blue underline + number (the quote is the UI)
                    │
                    └─ debounced 450ms ──▶ new File([JSON], '批注.json')  (card hidden in composer)
                                                │
                                                ▼
                        conversation.createDrafts(sessionId, [file])
                                                │  wait for fileUploads[id].status === "ready"
                                                ▼
                                  shell.addFiles([], [draftId])
                                                │
   user text + annotation attachment = one message with content [ {type:'text'}, {type:'file'} ]
                                                │
                                                ▼
        host `agent/pre-step`: drop the file block ──▶ append a separate user message (the JSON)
                                                │
                                                ▼
              model receives: your text (one message) + the annotation JSON (another), unmixed
```

The "引用" button takes a different route: `inputActions.insertQuote(text)` puts the excerpt
straight into the composer as a native DSH quote, with no attachment involved. After an annotation
on page text is created the plugin calls it too, so note and quote point at the same excerpt; if
the input state refuses the insertion (read-only or frozen), the annotation is still created — it
just has no quote to sit on.

The same route takes over the native "quote text" action. That action only calls
`insertQuote(text)` — it records nothing about where the text came from, so a note written on a quote
could never be marked back at its source. The plugin intercepts the click in the capture phase and
leaves the bubble, hover-card and button appearance untouched; only the insertion becomes ours
(`captureSource` + `rememberQuoteOrigin`), and the native surface is dismissed afterwards. When the
input state cannot accept the text, the click is handed back to DSH untouched.

Once a quote is inserted the plugin takes over the rest: it watches the quote projection for the new
entry and opens the note input at the source rect measured before insertion (clicking outside it
closes the input and keeps just the quote; if the quote already has a note, that same spot becomes
"清空"), and it catches clicks on a quote during the capture phase (without touching Lexical's DOM)
to open — or reuse — that quote's annotation. The quote's own remove button still works, but it now
also drops that quote's source mark and note. The hover-card is left alone, and the plugin draws no
quote bubble of its own, so nothing overlaps the native layer.

A quote annotation is therefore drawn in two places: on the quote itself (blue underline + number)
and at the source excerpt (the same highlight + badge the page annotations use). The latter is
located from the provenance the quote recorded; without provenance the plugin searches the page —
message rows first, then file previews — and writes the location into `source` when the note is
saved, so the next repaint can use it directly.

### Why this seam

DSH's `session.prompt` request schema is a **closed union** of `text | image | file`
(`dsh-api-session-controller`), so a plugin cannot introduce a custom content block type; and
`dsh-llm-deepseek` throws `UNSUPPORTED_CONTENT` on unknown user blocks. The supported way to get
plugin-authored content in front of the model is the `agent/pre-step` waterfall — the same seam
`@deepseek-ai/dsh-session-reference` uses for cross-session recall.

So the plugin uses a `file` block as the carrier: the UI already renders it as its own card, and
the host half turns it into its own message.

### Pitfalls worth knowing

1. **`addAttachments(ids)` alone is not enough.** It only appends ids to the input state; the
   runtime's private `draftAttachments` map has no matching entry, so `resolveDraftAttachments`
   fails at send time and the annotation never reaches the message. Let the runtime register the
   draft itself: `conversation.createDrafts(sessionId, [file])` → `shell.addFiles([], ids)`.
2. **Attaching before the upload is ready breaks the whole send.** `sendSession` throws
   "one or more files have not finished uploading". Wait for `fileUploads[id].status === 'ready'`.
3. **Releasing your own attachment must be masked from the consumption watcher**, otherwise the
   removal is mistaken for "the message was sent" and the annotation set is cleared.
4. **Do not decide "the attachment was consumed" from a notification — and do not use the
   runtime's private draft table either.** The submit path removes the attachment ids from the
   input state and only retires them later; for an attachment-only send (no text) the runtime
   keeps its draft entry alive until admission settles, so `resolveDraftAttachments` keeps
   returning it and that check never fires. Conversely, when the outcome is not a success the
   composer calls `restoreAttachments` and the ids come back. The rule that works: read the
   input shell's **live** `attachmentIds` field (not the published snapshot — it lags whenever
   nothing publishes), confirm after a short delay that it still does not hold your ids, and
   only then clear. That restore can also land long after the turn looks finished, so keep a
   short guard afterwards: if the ids come back, remove them — the annotations were already
   delivered, and a chip with nothing behind it just misleads.
5. **Rendered-DOM offsets are not source offsets.** For a multi-line selection they differ by the
   newline characters alone, and Markdown rendering drops `#`, `**`, and link URLs entirely. If a
   consumer will use the offsets against the file, resolve them against the file text
   (`ctx.remote.workspaceFiles.read`) rather than the DOM — that is what `textOrigin: "source"` marks.
   Reaching that API needs `'remote'` in the client module's `inject` list: the restricted client
   context only exposes declared services, so without it `ctx.remote` is simply absent and the
   lookup falls back to rendered coordinates without any error.
6. **The client sandbox has `console.log` and `console.error` — and no `console.warn`.**
   Calling a method that is not there throws, and a throw inside a `catch` turns a handled
   failure into an unhandled rejection that silently skips whatever came after it. Wrap every
   log call so it can never break a flow, and never let logging be the only trace of a failure
   path: on a surface without a console, the trace has to travel with the data.
7. **A `link:`-installed plugin cannot statically import `@deepseek-ai/*`.** Module resolution
   follows the plugin's real path (your source checkout), which has no `node_modules`, so those
   specifiers fail to resolve; a static import makes the whole host half fail to load
   (`fiberPhase` stays `null`) and the feature silently disappears from the UI. This plugin
   therefore imports nothing.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxPayloadBytes` | `524288` | Read cap for a single annotation attachment. A payload above it is treated as invalid and the message passes through untouched (never a truncated half-block). |

The plugin deliberately does **not** export a `Config` schema — that would require importing
`@deepseek-ai/schemastery`, which breaks `link:` installs (pitfall 4 above). You can still set
the option from a profile patch entry; `apply(ctx, config)` receives it as usual:

```yaml
- id: selection-annotations
  config:
    maxPayloadBytes: 1048576
```

## Troubleshooting

In the browser console:

```js
window.__dshSelectionAnnotations.list()      // current annotation set
window.__dshSelectionAnnotations.payload()   // the JSON block about to be submitted (string)
window.__dshSelectionAnnotations.drafts()    // attached draft ids — [] means nothing is attached
window.__dshSelectionAnnotations.receipt()   // same, first id only
window.__dshSelectionAnnotations.session()   // resolved current session id
window.__dshSelectionAnnotations.quotes()    // quote texts currently in the composer (from the projection)
window.__dshSelectionAnnotations.insertQuote('…')  // insert a quote by hand (debugging)
window.__dshSelectionAnnotations.add({...})  // add one by hand (debugging)
window.__dshSelectionAnnotations.update(id, note)  // edit one by hand (debugging)
```

`drafts()` is the hard indicator: an empty array means the annotations will **not** ride the next
message, whatever the UI looks like.

Warnings from the plugin are prefixed `[selection-annotations]`.

## Known limitations

- The **quote and source of an annotation cannot be edited** — only the note text, or delete and
  re-annotate.
- **A quote that straddles inline Markdown markup may lack line numbers.** Markdown line numbers
  come from reading the original file and locating the quote in it; if the quote crosses `**bold**`,
  a link, or a code span, the lookup misses and the annotation keeps rendered-DOM coordinates.
- Anchoring depends on semantic `data-*` attributes (`data-chat-anchor-key`,
  `data-chat-flow-kind`, `data-textpreview-url`, `data-code-preview`). If DSH renames them, the
  anchor layer in `client.js` needs updating.
- Character ranges are measured against the anchor element's `textContent`. If DSH changes what a
  message row renders, previously recorded ranges go stale and location falls back to
  quote + surrounding context.
- Conversation messages carry character ranges but no line numbers: after Markdown rendering, a
  visual line number is not a stable coordinate.
- **Quote annotations are matched to quote elements by text.** Lexical quote nodes expose no stable
  id, so the plugin remembers the element itself or aligns by text; with duplicate quotes, or after
  a page reload, the underline may land on the first occurrence.
- **A quote note's source mark needs the excerpt to be on the page.** Message rows always are; a
  closed file preview is not, and then the mark only exists on the quote. When provenance is missing
  the excerpt is searched in the page, so duplicate text lands on the first occurrence.
- **One note per excerpt.** Identity is the text plus its provenance (`【path:12–18】`); the same
  sentence in two files is two annotations, but when provenance is missing (conversation messages
  have no line numbers) two identical excerpts collapse into one.
- **Deleting a quote does not delete its note.** The quote leaves the composer the moment you send,
  and detaching the attachment then would race the send path and could hide the JSON from the host.
  Remove the leftover annotation from the panel instead.
- The `instruction` inside the payload and the plugin's own UI strings are currently hard-coded
  Chinese; they are not routed through the DSH locale service yet.

## Development

```sh
npm test
```

The suite runs in plain Node — no browser, no DSH install:

- `test/host-pre-step.test.mjs` — host half: stripping the file block, appending the JSON message,
  content-based claiming, merging, config branches.
- `test/client-half.test.mjs` — a minimal DOM + React + Cordis harness around `client.js` that
  drives the whole data path (annotation → JSON payload → runtime draft attachment → input state →
  cleared after send) plus anchor re-location, character-range capture, quote provenance
  (`source.kind: "quote"`), the "same excerpt, same note" provenance matching, and the location
  fallback that lets a quote note be marked at its source.
- `test/loader.mjs` / `test/schemastery-shim.mjs` — resolve `@deepseek-ai/schemastery` to a local
  stub so tests can run outside the host. Currently inert (the plugin imports nothing) but kept so
  that re-adding a host-side schema would not break local tests.

Reload behaviour while developing:

| Half | How a change takes effect |
|---|---|
| Client `client.js` | Hot-swapped by `@deepseek-ai/dsh-client-hmr` (~500ms poll). **Refresh the page.** |
| Host `lib/index.js`, already loaded once | **Does not hot-reload.** Neither disable→enable nor `remove_bundle` + `install_bundle` helps (Node ESM module cache). **Restart the host process.** |
| Host `lib/index.js`, previously failed to load (`fiberPhase: null`) | A single disable→enable re-imports it — **takes effect immediately** |

Do **not** use `remove_bundle` to force a reload of a `link:`-installed plugin: it has been
observed to remove the profile's dependency and `bundles` entries — leaving the plugin
uninstalled, with both halves unregistered — while still reporting `application: failed` /
`not-removable`. Recover with `install_bundle` pointed at the directory. Re-running
`install_bundle` is enough to re-materialize the client half.

To tell whether the plugin is actually running, check `fiberPhase` for its entry in
`plugin_manager list_plugins`: `active` means running, `null` means the module failed to load
(and the client half disappears with it).

To reproduce the host's module resolution locally, run this from the profile directory:

```sh
cd "$DSH_PROFILE_DIR"
node --input-type=module -e "import('@u2a5f/dsh-selection-annotations').then(m => console.log('OK', Object.keys(m))).catch(e => console.error('FAIL', e.message))"
```

## License

MIT
