---
"eve": patch
---

Report a model stream that ends without a provider finish event as an incomplete turn instead of a successful response. Preserve completed tool results and resolved input while keeping unfinished tool calls out of history, and withhold completed-message events until the provider finishes. Incomplete streams are not automatically retried, avoiding duplicate tool side effects.
