import { gateway, type LanguageModel, wrapLanguageModel } from "ai";

import { IncompleteModelStreamError } from "#harness/incomplete-model-stream.js";

type StreamResult = Awaited<ReturnType<ReturnType<typeof wrapLanguageModel>["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** Validate native completion before the SDK synthesizes its own step finish at EOF. */
export function withModelStreamIntegrity(
  model: LanguageModel,
): ReturnType<typeof wrapLanguageModel> {
  const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;
  return wrapLanguageModel({
    model: typeof model === "string" ? provider.languageModel(model) : model,
    middleware: {
      async wrapStream({ doStream, params }) {
        const result = await doStream();
        let terminal = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<StreamPart, StreamPart>({
              transform(part, controller) {
                if (part.type === "finish" || part.type === "error") terminal = true;
                controller.enqueue(part);
              },
              flush(controller) {
                if (!terminal && !params.abortSignal?.aborted) {
                  // An error event lets the SDK finalize responseMessages, including
                  // genuine tool results. Throwing here would lose that transcript.
                  controller.enqueue({ type: "error", error: new IncompleteModelStreamError() });
                }
              },
            }),
          ),
        };
      },
    },
  });
}
