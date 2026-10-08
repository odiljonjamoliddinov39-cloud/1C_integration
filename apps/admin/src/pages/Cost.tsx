import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CostChart } from "@/components/CostChart";
import { Card, Empty, ErrorText, Section, Select, Stat, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { compact, dateTime, usd } from "@/lib/format";
import { href } from "@/lib/router";

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

/** Where AI money goes, and the five numbers that show whether the cost engine works. */
export function CostPage() {
  const [days, setDays] = useState(7);
  const report = useQuery({ queryKey: ["ai-cost", days], queryFn: () => api.aiCost(days) });
  const r = report.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">AI cost</h1>
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>Today</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </Select>
        {r && <span className="tabular ml-auto text-sm text-muted-foreground">Total {usd(r.totalUsd)}</span>}
      </div>
      <ErrorText error={report.error} />
      {r?.alert.exceeded && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Today&apos;s AI cost is {usd(r.alert.todayUsd)}, over the alert level of {usd(r.alert.thresholdUsd)}
          . Look at the dearest questions below, or lower the limits on the AI limits page.
        </div>
      )}
      {r && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Cost per question"
              value={usd(r.metrics.costPerQuestionUsd)}
              note={`${compact(r.metrics.questions)} questions`}
            />
            <Stat
              label="Cache hit rate"
              value={percent(r.metrics.cacheHitRate)}
              note="cached ÷ all input tokens"
            />
            <Stat
              label="Free answers"
              value={percent(r.metrics.freeAnswerShare)}
              note="template + cache, 0 tokens"
            />
            <Stat
              label="Tokens per question"
              value={compact(r.metrics.avgTokensPerQuestion)}
              note="input, output and cache"
            />
            <Stat
              label="1C reads per question"
              value={String(r.metrics.avgToolCallsPerQuestion)}
              note="tool calls on average"
            />
          </div>

          <Section title="AI cost per day (USD)">
            <CostChart
              days={r.byDay.map((d) => ({
                date: d.date,
                costUsd: d.costUsd,
                requests: d.requests,
                tokens: 0,
              }))}
            />
          </Section>

          <Section title="By customer">
            {r.byAccount.length === 0 ? (
              <Empty>No AI use in this period.</Empty>
            ) : (
              <Table head={["Customer", "Cost", "Questions", "Requests", "This month", "Cap"]}>
                {r.byAccount.map((a) => (
                  <tr key={a.accountId}>
                    <Td>
                      <a className="text-primary hover:underline" href={href(`customers/${a.accountId}`)}>
                        {a.accountName}
                      </a>
                    </Td>
                    <Td>{usd(a.costUsd)}</Td>
                    <Td>{a.questions}</Td>
                    <Td>{a.requests}</Td>
                    <Td>{usd(a.monthUsd)}</Td>
                    <Td>{a.limitUsd === null ? "policy" : a.limitUsd === 0 ? "none" : usd(a.limitUsd)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="By user">
              <Table head={["User", "Customer", "Cost", "Requests"]}>
                {r.byUser.map((u) => (
                  <tr key={u.userId}>
                    <Td>{u.email}</Td>
                    <Td>{u.accountName}</Td>
                    <Td>{usd(u.costUsd)}</Td>
                    <Td>{u.requests}</Td>
                  </tr>
                ))}
              </Table>
            </Section>
            <div className="space-y-4">
              <Section title="By feature">
                <Table head={["Feature", "Cost", "Requests"]}>
                  {r.byFeature.map((f) => (
                    <tr key={f.feature}>
                      <Td>{f.feature}</Td>
                      <Td>{usd(f.costUsd)}</Td>
                      <Td>{f.requests}</Td>
                    </tr>
                  ))}
                </Table>
              </Section>
              <Section title="By route">
                <Table head={["Answered by", "Cost", "Requests"]}>
                  {r.byRoute.map((f) => (
                    <tr key={f.route}>
                      <Td>{f.route}</Td>
                      <Td>{usd(f.costUsd)}</Td>
                      <Td>{f.requests}</Td>
                    </tr>
                  ))}
                </Table>
              </Section>
            </div>
          </div>

          <Card>
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">The 20 most expensive questions of the week</h2>
              <p className="text-xs text-muted-foreground">
                The first place to look for the next saving: the frequent ones can become query templates.
              </p>
            </div>
            {r.topQuestions.length === 0 ? (
              <Empty>No questions yet.</Empty>
            ) : (
              <Table head={["Question", "Customer", "Cost", "Steps", "1C reads", "Last asked"]}>
                {r.topQuestions.map((q, i) => (
                  <tr key={i}>
                    <Td className="max-w-md truncate" title={q.question}>
                      {q.question}
                    </Td>
                    <Td>{q.accountName}</Td>
                    <Td>{usd(q.costUsd)}</Td>
                    <Td>{q.steps}</Td>
                    <Td>{q.toolCalls}</Td>
                    <Td>{dateTime(q.lastAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
