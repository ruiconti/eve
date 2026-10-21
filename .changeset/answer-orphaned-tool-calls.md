---
"eve": patch
---

Answer tool calls that have no result in a session's saved history with an error result when building the model prompt, so a history cut after a tool call (for example by a crash) no longer fails every later model call with `AI_MissingToolResultsError`.
