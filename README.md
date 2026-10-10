# dsh-selection-annotations

[English](README.md) · [简体中文](README.zh-CN.md)

> Select text anywhere in the DSH Web UI — an assistant reply, a workspace file, a message from
> an earlier conversation — leave a note, and send the whole set with your next message as a
> **separate, machine-readable JSON block**. Your message text is never touched.

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
| Highlight + numbered badge | Light-yellow overlay plus a numbered badge, anchored on semantic `data-*` attributes. Re-located after scroll or re-render by character range + quote context. |
| **Click the badge to edit** | Clicking a badge opens *that* annotation for editing (change the note, or delete it). The list panel has the same entry point. |
| Precise positions | Every annotation records `charStart`/`charEnd` (a half-open range over the anchor element's `textContent`). File sources additionally record 1-based `lineStart`/`lineEnd` and the workspace-relative `path`. |
| Trigger next to Send | Registered into `conversation.input.right`, so it occupies one compact control slot and never disturbs the composer layout. |
| Floating panel | The "批注 ×N" panel is plain DOM appended to `body` with `position: fixed` — it is completely out of flow and never pushes the input box around. |
| Sent as a separate block | The annotation set is packed into a `File` (`批注.json`) and handed to the runtime's own `createDrafts` + the input shell's `addFiles` — the exact path drag-and-drop attachments use. It is attached only once the upload reports `ready`. |
| Separate message for the model | The host half strips that file block from the model-visible content during `agent/pre-step` and appends an independent user message whose body is the JSON. |
| Consumed on send | Once the attachment is consumed (or manually removed), the set clears — it never sticks to the next message. |

## Payload format

The model receives one extra message whose entire body is a self-describing JSON block:

```json
{
  "kind": "dsh-selection-annotations",
  "version": 1,
  "instruction": "This is an annotation block the user attached to the previous message. It is separate from, and not part of, the user's message text. annotations[].quote is the text the user selected; annotations[].source gives its position ...",
  "count": 2,
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
        "charEnd": 130
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
        "charEnd": 46
      }
    }
  ]
}
```

Notes on the contract:

- **JSON, not prose.** Positions are things a program consumes — line numbers, character
  ranges, anchor keys. Structured fields do not get lost in natural language.
- `charStart`/`charEnd` is a **half-open range** `[charStart, charEnd)` measured over the anchor
  element's `textContent`. A quote can repeat; a character range cannot.
- `lineStart`/`lineEnd` are **1-based** and only present for workspace file sources.
- The host claims the payload **by content**: the parsed JSON must carry
  `kind: "dsh-selection-annotations"`. The file name is only a cheap pre-filter, so renaming the
  attachment still works.
- Multiple annotation attachments are merged into one block and `index` is renumbered `1..N`.

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
                    ├─ locally: highlight + numbered badge + floating panel
                    │
                    └─ debounced 450ms ──▶ new File([JSON], '批注.json')
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
4. **A `link:`-installed plugin cannot statically import `@deepseek-ai/*`.** Module resolution
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
window.__dshSelectionAnnotations.add({...})  // add one by hand (debugging)
window.__dshSelectionAnnotations.update(id, note)  // edit one by hand (debugging)
```

`drafts()` is the hard indicator: an empty array means the annotations will **not** ride the next
message, whatever the UI looks like.

Warnings from the plugin are prefixed `[selection-annotations]`.

## Known limitations

- The **quote and source of an annotation cannot be edited** — only the note text, or delete and
  re-annotate.
- **Markdown previews have no line numbers.** Code previews fall back to the `.line` index and
  plain-text previews use `data-textpreview-line`, but a rendered Markdown document has neither,
  so those annotations carry a character range only.
- Anchoring depends on semantic `data-*` attributes (`data-chat-anchor-key`,
  `data-chat-flow-kind`, `data-textpreview-url`, `data-code-preview`). If DSH renames them, the
  anchor layer in `client.js` needs updating.
- Character ranges are measured against the anchor element's `textContent`. If DSH changes what a
  message row renders, previously recorded ranges go stale and location falls back to
  quote + surrounding context.
- Conversation messages carry character ranges but no line numbers: after Markdown rendering, a
  visual line number is not a stable coordinate.

## Development

```sh
npm test
```

The suite runs in plain Node — no browser, no DSH install:

- `test/host-pre-step.test.mjs` — host half: stripping the file block, appending the JSON message,
  content-based claiming, merging, config branches.
- `test/client-half.test.mjs` — a minimal DOM + React + Cordis harness around `client.js` that
  drives the whole data path (annotation → JSON payload → runtime draft attachment → input state →
  cleared after send) plus anchor re-location and character-range capture.
- `test/loader.mjs` / `test/schemastery-shim.mjs` — resolve `@deepseek-ai/schemastery` to a local
  stub so tests can run outside the host. Currently inert (the plugin imports nothing) but kept so
  that re-adding a host-side schema would not break local tests.

Reload behaviour while developing:

| Half | How a change takes effect |
|---|---|
| Client `client.js` | Hot-swapped by `@deepseek-ai/dsh-client-hmr` (~500ms poll). **Refresh the page.** |
| Host `lib/index.js`, already loaded once | **Does not hot-reload.** Neither disable→enable nor `remove_bundle` + `install_bundle` helps (Node ESM module cache). **Restart the host process.** |
| Host `lib/index.js`, previously failed to load (`fiberPhase: null`) | A single disable→enable re-imports it — **takes effect immediately** |

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
