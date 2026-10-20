import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { environment } from "../sandbox.js";

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
  // The step imports its own copy of the environment the session's sandbox uses.
  const sandbox = await ctx.getSandbox(environment);
  const seed = await sandbox.readTextFile({ path: "/workspace/step-seed.txt" });
  // Writing the whole file keeps a retried step's write the same.
  await sandbox.writeTextFile({
    content: `${seed}:prepared-in-step`,
    path: "/workspace/step-note.txt",
  });
  return "prepared";
}
