---
"eve": patch
---

The session input-token limit now counts only new input (uncached input plus cache writes). Cache reads no longer count toward the limit, the grant after Continue, or the quota shared with subagents, so long cache-heavy sessions stop hitting continuation prompts for replaying their own history. Usage telemetry still reports raw input and cache totals. Providers that report no cache details count exactly as before.
