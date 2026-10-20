import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// A workflow step asks for the child's sandbox before the child opened it, so
// the child opens it for the step; a later tool call reads the step's note.
const NOTE = "step-sandbox-note-ok-H3R:prepared-in-step";

export default defineEval({
  description: "Sandbox: a workflow step shares the calling session's sandbox.",
  async test(t) {
    const turn = await t.send(
      "Ask the `step-sandbox` subagent with message: " +
        "Alice is preparing an analysis workspace. Prepare the note and read it back.",
    );
    turn.expectOk();

    t.succeeded();
    t.calledSubagent("step-sandbox", { count: 1, status: "completed" });
    t.check(turn.message, includes(NOTE));
  },
});
