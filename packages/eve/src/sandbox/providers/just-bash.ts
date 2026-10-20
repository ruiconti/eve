import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/local.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export type JustBashEnvironmentOptions = JustBashSandboxCreateOptions;

export const JustBashSandbox = defineSandboxProvider<
  JustBashEnvironmentOptions,
  undefined,
  { readonly templateKey: string },
  { readonly version: 3 },
  SandboxSession
>({
  name: "just-bash",
  environment: (options) => createJustBashSandboxProvider(options),
});
