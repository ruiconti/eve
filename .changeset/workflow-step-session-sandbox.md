---
"eve": patch
---

A `"use step"` helper in a workflow tool can now call `ctx.getSandbox()` to open the sandbox of the session that called the tool, on any sandbox provider, so a task can prepare files the session's later tool calls read without a `task.started` hook. The step never owns the sandbox: if the session has not opened it yet, the session opens and records it for the step, and deletes it when the session ends.
