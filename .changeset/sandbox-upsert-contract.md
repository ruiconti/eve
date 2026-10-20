---
"eve": minor
---

Custom sandbox providers must now make `start()` an idempotent upsert keyed by `context.session.id`, derive the sandbox's identity from that key and never from open options or the artifact, and implement `onSessionEnd(context, state, { reason })`. `onSessionEnd` is now required, no longer receives the artifact, and must delete by key when `state` is `null` and succeed when nothing exists. In exchange, a session now deletes a sandbox that only a sharing subagent opened, and keyed `invokeTool` tool sessions work with every provider. Built-in providers keep a session's sandbox across rebuilds and open-option changes.
