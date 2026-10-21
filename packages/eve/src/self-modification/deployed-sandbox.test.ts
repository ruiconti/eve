import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeployedSelfModificationConfig } from "./remote/config.js";
import {
  defineDeployedSelfModificationSandbox,
  selectDeployedSelfModificationEnvironment,
} from "./deployed-sandbox.js";

const connectConfig: DeployedSelfModificationConfig = {
  authorize: () => true,
  credentials: { pat: true },
  source: { git: { directory: ".", repository: "github.com/acme/agent" } },
  target: { branch: "main" },
};

afterEach(() => vi.unstubAllEnvs());

describe("deployed self-modification sandbox", () => {
  it("selects Vercel Sandbox on Vercel", () => {
    expect(
      selectDeployedSelfModificationEnvironment({ isDeployedOnVercel: () => true }).provider,
    ).toBe("vercel");
  });

  it("requires Vercel Sandbox outside Vercel", () => {
    expect(() =>
      selectDeployedSelfModificationEnvironment({ isDeployedOnVercel: () => false }),
    ).toThrow("Deployed self-modification requires Vercel Sandbox");
  });

  it("does not probe deployed providers during eve dev", () => {
    vi.stubEnv("EVE_DEV", "1");
    const probes = { isDeployedOnVercel: vi.fn() };
    expect(defineDeployedSelfModificationSandbox(connectConfig, probes)).toBeTypeOf("function");
    expect(probes.isDeployedOnVercel).not.toHaveBeenCalled();
  });
});
