---
"eve": patch
---

Repair orphaned local tool calls in saved history before the next model request with an explicit unknown-outcome error. The repair never reruns tools, moves recorded results, or settles work still owned by approvals, workflows, or tasks.
