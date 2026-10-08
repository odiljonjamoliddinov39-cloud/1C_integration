/** How the dashboard names the assistant's models and effort levels. */
import { AI_MODELS, type AiEffort } from "@platform/shared";

export const EFFORTS: { id: AiEffort; name: string; note: string }[] = [
  { id: "low", name: "Low", note: "Fastest and cheapest; thinks only when a step needs it." },
  { id: "medium", name: "Medium", note: "Balanced: quick on simple steps, careful on harder ones." },
  { id: "high", name: "High", note: "Thinks each step through. Best quality for most accounting work." },
  {
    id: "xhigh",
    name: "Extra high",
    note: "More thinking on long, multi-step jobs (audits, reconciliations).",
  },
  { id: "max", name: "Max", note: "The most thorough, and the slowest and most expensive." },
];

export function modelName(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.name ?? id;
}

export function effortName(id: string): string {
  return EFFORTS.find((e) => e.id === id)?.name ?? id;
}
