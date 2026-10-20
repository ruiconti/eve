import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// The child's turn writes a seed, a workflow step reads it and writes a note,
// and a later tool call reads the note back: both see one sandbox.
const NOTE = "step-sandbox-seed-ok-H3R:prepared-in-step";

export default defineEval({
  description: "Sandbox: a workflow step shares the calling session's sandbox.",
  async test(t) {
    const turn = await t.send(
      "Ask the `step-sandbox` subagent with message: " +
        "Alice is preparing an analysis workspace. Seed the note, prepare it, and read it back.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledSubagent("step-sandbox", { count: 1, status: "completed" });
    t.check(turn.message, includes(NOTE));
  },
});
