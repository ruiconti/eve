---
"eve": patch
---

A `"use step"` helper in a workflow tool can now call `ctx.getSandbox()` to open the sandbox of the session that called the tool, so a task can prepare files the session's later tool calls read without a `task.started` hook. The step never owns the sandbox: eve releases its handle when the step ends, and only Vercel Sandbox and just-bash support it; other providers fail with an error that names the provider.
