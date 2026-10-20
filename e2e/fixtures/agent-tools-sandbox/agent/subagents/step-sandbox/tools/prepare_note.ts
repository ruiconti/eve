import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Prepares the note from the seed in a workflow step.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    return await prepareNote(ctx);
  },
});

async function prepareNote(ctx: WorkflowStepToolContext) {
  "use step";
  const sandbox = await ctx.getSandbox();
  const seed = await sandbox.readTextFile({ path: "/workspace/step-seed.txt" });
  // Writing the whole file keeps a retried step's write the same.
  await sandbox.writeTextFile({
    content: `${seed}:prepared-in-step`,
    path: "/workspace/step-note.txt",
  });
  return "prepared";
}
