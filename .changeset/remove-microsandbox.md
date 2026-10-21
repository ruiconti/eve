---
"eve": minor
---

Remove the microsandbox sandbox provider: the `eve/sandbox/microsandbox` export and the `microsandbox` option on `DefaultSandbox.environment()` are gone, and `DefaultSandbox` now selects Vercel Sandbox on Vercel, then Docker, then just-bash. Deployed self-modification (`eve/self-modification/remote`) now requires Vercel Sandbox and fails to compile outside Vercel with an actionable error.
