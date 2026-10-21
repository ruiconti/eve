---
"eve": minor
---

Make sandbox creation a concurrent, session-keyed upsert and require idempotent terminal cleanup by key, even when provider state was never checkpointed. Built-in providers preserve sandbox identity across rebuilds and option changes, and microsandbox serializes native lifecycle transitions across processes without replacing a running VM.
