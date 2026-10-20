---
"eve": patch
---

A session whose sandbox is gone (for example after a microsandbox daemon restart, a removed Docker container, or a deleted Vercel Sandbox) now starts a fresh sandbox on its next `ctx.getSandbox()`. Previously every sandbox call in that session failed with the same resume error until the session ended.
