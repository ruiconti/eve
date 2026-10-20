import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Writes the seed note into the session's sandbox.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({
      content: "step-sandbox-seed-ok-H3R",
      path: "/workspace/step-seed.txt",
    });
    return "seeded";
  },
});
