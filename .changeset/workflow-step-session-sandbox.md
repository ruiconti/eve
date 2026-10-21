---
"eve": patch
---

A `"use step"` helper in a workflow tool can now call `ctx.getSandbox()` to open the sandbox of the session that called the tool, on any sandbox provider, so a task can prepare files the session's later tool calls read without a `task.started` hook. The step creates the sandbox with the session's sandbox definition when the session has not opened it yet, never owns it, and the session removes it when the session ends.
