import type { ModelMessage } from "ai";

export class IncompleteModelStreamError extends Error {
  constructor() {
    super(
      "The model stream ended without a provider finish event. The response is incomplete and was not retried; completed tool results were preserved.",
    );
    this.name = "IncompleteModelStreamError";
  }
}

type CompletedToolMessage = Extract<ModelMessage, { role: "assistant" | "tool" }>;

/**
 * Keep completed tool work without committing partial text or unanswered calls
 * from a stream that ended before the provider finished.
 */
export function completedToolMessages(
  responseMessages: readonly ModelMessage[],
): CompletedToolMessage[] {
  const completedCallIds = new Set<string>();
  for (const message of responseMessages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") completedCallIds.add(part.toolCallId);
    }
  }

  const messages: CompletedToolMessage[] = [];
  for (const message of responseMessages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) =>
          part.type === "tool-result" ||
          (part.type === "tool-call" && completedCallIds.has(part.toolCallId)),
      );
      if (content.length > 0) messages.push({ ...message, content });
    } else if (message.role === "tool") {
      const content = message.content.filter((part) => part.type === "tool-result");
      if (content.length > 0) messages.push({ ...message, content });
    }
  }
  return messages;
}
