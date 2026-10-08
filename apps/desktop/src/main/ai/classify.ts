/**
 * What a question is, judged by words alone: a "lookup" is a short read of a figure or a list, which
 * may run on the cheaper model when the policy has one; everything else is "work". When unsure it is
 * work: a cheaper answer must never replace a correct one.
 */

const READ =
  /(сколько|покажи|показать|какой|какая|какие|остаток|сальдо|баланс|список|выведи|найди|qancha|ko['‘’]rsat|qoldiq|ro['‘’]yxat|topib|show|list|how much|what is|balance|find)/iu;
const NOT_A_LOOKUP =
  /(создай|создать|сделай|введи|внеси|проведи|удали|измени|исправь|заполни|загрузи|выпиши|почему|анализ|сравни|аудит|проверь|сверк|рассчитай|подготовь|yarat|kirit|qo['‘’]sh|o['‘’]chir|o['‘’]zgartir|to['‘’]ldir|yoz\b|tahlil|solishtir|nega|tekshir|create|\badd\b|enter|post|delete|change|fix|fill|import|write|make|why|analy|compare|check|reconcil|prepare)/iu;

export function classifyTask(question: string, hasAttachments: boolean): "lookup" | "work" {
  if (hasAttachments || question.length > 160) return "work";
  return READ.test(question) && !NOT_A_LOOKUP.test(question) ? "lookup" : "work";
}
