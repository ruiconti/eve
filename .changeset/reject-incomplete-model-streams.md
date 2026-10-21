---
"eve": patch
---

Report a model stream that ends without a provider finish event as an incomplete turn instead of a successful response. Preserve completed tool results through the same normalization and media staging as successful responses, without delaying healthy streaming. Incomplete streams are not automatically retried. Before a later model request, repair unambiguous orphaned local calls in older history using their recorded result or an explicit unknown-outcome error, without rerunning tools or settling active work.
