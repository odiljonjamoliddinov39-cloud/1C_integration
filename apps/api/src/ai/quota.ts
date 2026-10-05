/**
 * How AI use counts against the daily cap and the plan quota. Every step of an answer re-reads the
 * cached prompt (instructions, tools, the chat so far); a cache read costs a tenth of fresh input,
 * so it counts a tenth. Counted in full, one question with a few 1C lookups used most of a day.
 */
import { sql } from "drizzle-orm";

/** Over the ai_usage table (unaliased). */
export const QUOTA_TOKENS = sql.raw(
  "(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens / 10.0)",
);
