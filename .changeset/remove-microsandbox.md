---
"eve": minor
---

Remove the microsandbox sandbox provider: the `eve/sandbox/microsandbox` export and the `microsandbox` option on `DefaultSandbox.environment()` are gone, and `DefaultSandbox` now selects Vercel Sandbox on Vercel, then Docker, then just-bash. To migrate, replace `MicrosandboxSandbox.image()` and `MicrosandboxSandbox.dockerfile()` with `DockerSandbox.image()` and `DockerSandbox.dockerfile()` from `eve/sandbox/docker`, and remove the `microsandbox` dependency. Deployed self-modification (`eve/self-modification/remote`) now requires Vercel Sandbox: builds still succeed on any host, but the deployed subagent fails with an actionable error when it opens its sandbox outside Vercel.
