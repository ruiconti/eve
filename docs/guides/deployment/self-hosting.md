---
title: "Self-Host eve"
description: "Run an eve agent as a Node service with your own workflow storage, sandbox provider, and routing."
---

Self-host eve when you operate a Node service, container platform, or reverse proxy. You run eve’s Nitro server and choose the infrastructure that stores workflows and executes sandbox sessions.

## Build and start the Node service

Build the agent, then start the generated server:

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

The build writes the Nitro server under `.output/`. `eve start` serves that output and accepts either `PORT` or the `--port` flag.

Run this process under the same process manager or container platform you use for other Node web services. Configure Transport Layer Security (TLS), scaling, restarts, and log collection in that platform.

## Configure model access and route auth

Set `AI_GATEWAY_API_KEY` to use a string model ID through the Vercel AI Gateway from a non-Vercel host. To call a provider directly, install its [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models). Then pass its model object in `agent.ts` and set its API key. See [Agent configuration](../../agent-config#set-the-model) for examples.

Don’t rely on `vercelOidc()` as the only production authenticator outside Vercel. Configure Basic auth, JSON Web Token (JWT) verification, generic OpenID Connect (OIDC), or a custom verifier that your host can validate. See [Authentication](../auth-and-route-protection).

## Persist workflow state

The default local Workflow world stores run state under `.eve/.workflow-data`. Mount that directory on persistent storage so runs survive process and container replacement.

You can instead select an installed Workflow world package in the root `agent.ts`:

```typescript
import { defineAgent } from "eve";

export default defineAgent({
  experimental: {
    workflow: {
      world: "@acme/eve-workflow-world",
    },
  },
});
```

The package must export a default factory or `createWorld()` function. Read credentials and host options from runtime environment variables. Install a world built against the same `@workflow/*` line as your eve release. The current line is `5.0.0-beta`, and the runtime rejects incompatible protocol versions.

See [Workflow Worlds](https://workflow-sdk.dev/worlds) for the underlying Workflow software development kit (SDK) abstraction.

## Upgrade eve

Pin the exact eve version in `package.json` so upgrades happen only when you choose them. With the default local world, Postgres, or another world without per-deployment routing, serve one world from one eve version at a time. Restarting a process with the same eve version can resume its persisted runs; changing the eve version cannot replay existing session runs on the new version.

Unlike Vercel Workflow, these worlds do not route runs back to the deployment that started them. Before upgrading, let in-flight work finish and plan for existing conversations to start fresh sessions.

### Recover stranded sessions

A session is **stranded** when its owner run was built by another eve version and the current deployment cannot replay it. Its recorded history remains readable, but it cannot process new work. Sessions whose runs recorded no eve version are treated the same way.

Recovery depends on how you address the session:

- **Channel address**, such as a Slack thread: the next ordinary message ends the stranded session and starts one fresh session at the same address, even when messages arrive concurrently. A delivery containing input responses is refused instead, because a fresh session has no matching request. See [custom channel operations](../../channels/custom#channel-operations-and-session-handles).
- **Session ID**: sends and live streams report `session_stranded`; eve never replaces the session implicitly. Read any history you need with `stream({ follow: false })`, reset the old session, and explicitly create a new one. Clear is refused because it would preserve a session that cannot run. See [the eve HTTP channel](../../channels/eve#start-and-continue-a-session) and [TypeScript client recovery](../client/messages).

A replacement starts with its own ID and state, without the earlier conversation. Automatic channel replacement supplies `ctx.session.predecessor.sessionId` so your instructions can optionally [read the earlier conversation](../session-context#read-a-replaced-sessions-conversation). An explicit reset leaves the next session no predecessor link. Messages accepted before the upgrade are not redelivered.

Reset cannot be undone. It cancels the stranded run without executing its code or its `session.completed` and `session.failed` hooks. It does not undo side effects, stop independent external jobs, or carry interrupted work into a replacement. Rolling back to the original eve version can help only before the session is reset.

A stranded root session keeps its address until a channel message replaces it, an explicit reset ends it, or its [session timeout](../../agent-config#runtime-limits) elapses. With `sessionTimeoutMs: false`, it waits until a message or reset. Stranded subagent sessions and workflow tool runs are cancelled separately when the world next delivers work to them; ending the root session does not find or cancel them. Cancel any remaining runs directly in your Workflow world if needed.

The same version boundary applies in `eve dev`. A previous invocation's session built by the same eve version is not stranded; use [local workflow recovery](../../reference/cli#local-workflow-recovery) to resume it.

## Select a sandbox provider

The default sandbox environment selects Docker, microsandbox, or just-bash according to local availability. You can select one explicitly or implement a custom provider with `defineSandboxProvider()` for your container, virtual machine, or isolation service.

Don’t select `VercelSandbox.environment()` unless the self-hosted process should create hosted Vercel sandboxes. See [Sandbox](../../sandbox) for provider configuration and selection order.

## Configure proxy routes

Forward both runtime route prefixes through your reverse proxy or ingress:

- `/eve/` serves health, sessions, streams, channels, tools, and subagents
- `/.well-known/workflow/` receives workflow callbacks

A proxy restricted to `/eve/` lets a session start, but the run stalls when its callback can’t reach eve. Preserve both prefixes without rewriting their paths.

## Run workspace members

An [agent workspace](../../concepts/project-structure#several-root-agents) does not require Vercel or a frontend at runtime. Build each member from its own directory: root `eve build` produces a Vercel workspace deployment, not a group of self-hosted Node servers.

For a workspace containing `support` and `research`, run these from the workspace root, outside a Vercel build environment:

```bash
(cd agents/support && npx eve build)
(cd agents/research && npx eve build)
```

Start each built agent in a separate terminal, or configure these commands in your process manager:

```bash
(cd agents/support && npx eve start --host 127.0.0.1 --port 3001)
(cd agents/research && npx eve start --host 127.0.0.1 --port 3002)
```

For example, this Caddy configuration gives each agent its own origin and forwards both `/eve/` and `/.well-known/workflow/` without changing their paths. Point the example hostnames at your server and run Caddy on the same machine:

```text
support.example.com {
    reverse_proxy 127.0.0.1:3001
}

research.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

Apply the authentication, persistent storage, and sandbox configuration above to each member. With the default local Workflow world, persist each member's own `.eve/.workflow-data` directory. If agents delegate to one another, configure an explicit [workspace-peer transport](../../subagents#vercel-workspace-peers) with the peer's URL and credentials; the default transport requires Vercel. Ensure callback URLs are reachable from the services that call them.

### Add a peer frontend

A frontend under `apps/web/` is another service managed by your host, not by `eve start`. Build and start it using its framework commands. A browser client can use `useEveAgent({ host: "https://support.example.com" })`; configure [CORS](../../channels/eve#cors) and browser credentials for that deployment. Alternatively, mount each agent on the frontend's origin through your reverse proxy.

For path-based mounts, strip the public prefix before forwarding requests to the agent and set `EVE_PUBLIC_ROUTE_PREFIX` in that agent's build and runtime environments. Forward its workflow callback routes as well as its eve routes. Keep the browser client, callback URLs, and peer transports consistent with the public mounts.

You can instead use [`eve/next`](../frontend/nextjs#dev-vs-deploy-topology) if you want Next.js to start built agent processes and provide the browser-facing proxy routes. That integration is optional; `eve/vercel` configuration is not used by a self-hosted process manager.

## Run schedules

The standard `eve build && eve start` path starts Nitro’s schedule runner. If you adapt the output to a custom HTTP-only host or preset, run Nitro scheduled tasks or invoke the same work from your scheduler.

Each `eve start` process runs every authored schedule. When you run several replicas, start one normally and start the others with `eve start --no-schedules`, or set `EVE_SCHEDULES_DISABLED=1` in their environment. See [`eve start`](../../reference/cli#eve-start).

## Verify the service

Check the health route after your proxy and authentication configuration are active:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development TUI and complete a real turn:

```bash
eve remote connect --url https://your_agent.example.com
```

## Continue configuring production

Use these guides to secure and observe the deployed agent:

- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox provider
