import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { loadConfig } from "./config.js";

export const modelSettings = {
  parallelToolCalls: false,
  provider: { data_collection: "deny" },
  reasoning: { effort: "low" },
} as const;

export function createModel(env: Record<string, string | undefined> = process.env) {
  const { OPENROUTER_API_KEY, MODEL_ID } = loadConfig(["OPENROUTER_API_KEY", "MODEL_ID"], env);
  const openrouter = createOpenRouter({ apiKey: OPENROUTER_API_KEY });
  return openrouter(MODEL_ID, {
    parallelToolCalls: modelSettings.parallelToolCalls,
    provider: { data_collection: modelSettings.provider.data_collection },
    reasoning: { effort: modelSettings.reasoning.effort },
  });
}
