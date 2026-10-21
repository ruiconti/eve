import type { ModelMessage, ToolModelMessage } from "ai";

import { stageToolResultMedia } from "#harness/attachment-staging.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";
import { normalizeProviderToolHistory } from "#harness/provider-tool-history.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";

/** Prepare completed model work for durable history, including work retained after EOF. */
export async function prepareModelHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly result: Pick<HarnessStepResult, "content" | "toolResults">;
  /** On incomplete streams, retain completed work despite a transient media-store failure. */
  readonly onMediaStagingError?: (error: unknown) => void;
}): Promise<{ readonly messages: ModelMessage[]; readonly outcomeEndsResponse: boolean }> {
  const providerExecutedOutcomeIds = new Set<string>();
  for (const part of [...(input.result.content ?? []), ...(input.result.toolResults ?? [])]) {
    if (
      (part.type === "tool-result" || part.type === "tool-error") &&
      part.providerExecuted === true
    ) {
      providerExecutedOutcomeIds.add(part.toolCallId);
    }
  }
  const normalized = normalizeProviderToolHistory({
    messages: input.messages,
    providerExecutedOutcomeIds,
  });
  return {
    messages: await stageHistoryMedia(
      withoutApprovalParts(normalized.messages),
      input.onMediaStagingError,
    ),
    outcomeEndsResponse: normalized.outcomeEndsResponse,
  };
}

async function stageHistoryMedia(
  messages: readonly ModelMessage[],
  onError: ((error: unknown) => void) | undefined,
): Promise<ModelMessage[]> {
  if (onError === undefined) return stageToolResultMedia(messages);
  return Promise.all(
    messages.map(async (message): Promise<ModelMessage> => {
      if (message.role !== "tool") return message;
      const content = await Promise.all(
        message.content.map(async (part): Promise<ToolModelMessage["content"][number]> => {
          if (part.type !== "tool-result" || part.output.type !== "content") return part;
          const output = part.output;
          if (!output.value.some((item) => item.type === "file" && item.data.type === "data"))
            return part;
          try {
            const [staged] = await stageToolResultMedia([{ ...message, content: [part] }]);
            return staged!.content[0]!;
          } catch (error) {
            // Only recognized transient storage failures degrade. Malformed output,
            // programming errors, and cancellation must still fail preparation.
            if (classifyModelCallError(error) !== "retry") throw error;
            onError(error);
            return {
              ...part,
              output: {
                ...output,
                value: output.value.map((item) =>
                  item.type === "file" && item.data.type === "data"
                    ? {
                        type: "text" as const,
                        text: "Media persistence error: this tool already executed, but its returned file could not be stored. Do not execute the tool again just to recover the file.",
                      }
                    : item,
                ),
              },
            };
          }
        }),
      );
      return { ...message, content };
    }),
  );
}

export function commitModelHistory(
  step: Step,
  promptMessages: readonly ModelMessage[],
  responseMessages: readonly ModelMessage[],
): void {
  // Append to the durable prompt, never to its hydrated model-call copy.
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages([...promptMessages, ...responseMessages]),
  };
}

/** The SDK's approval parts: eve answers approvals itself, so history never holds them. */
export function withoutApprovalParts(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant" && message.role !== "tool") return [message];
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.filter(
      (part) => part.type !== "tool-approval-request" && part.type !== "tool-approval-response",
    );
    return content.length === 0 ? [] : [{ ...message, content } as ModelMessage];
  });
}
