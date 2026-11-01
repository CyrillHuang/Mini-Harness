import { Session } from "../session/session.js"
import { createTokenMeter } from "../session/token-meter.js"

const session = new Session()

for (const text of ["old one", "old two", "old three", "latest"]) {
  await session.append({
    type: "user/message",
    data: { role: "user", text },
    surfaceOp: "append",
  })
}

const firstPlan = session.planCompaction(
  "pressure",
  { contextWindow: 30, thresholdRatio: 0, retainRatio: 0.4 },
  createTokenMeter(),
)
if (!firstPlan) throw new Error("expected the first compaction plan")
await session.compact(firstPlan, async () => "first summary")

await session.append({
  type: "user/message",
  data: { role: "user", text: "newest" },
  surfaceOp: "append",
})

const secondPlan = session.planCompaction(
  "pressure",
  { contextWindow: 45, thresholdRatio: 0, retainRatio: 0.4 },
  createTokenMeter(),
)
if (!secondPlan) throw new Error("expected the second compaction plan")
if (secondPlan.shadowedRange.start <= secondPlan.shadowedRange.end) {
  throw new Error("fixture did not produce reverse-ordered surface endpoints")
}

await session.compact(secondPlan, async () => "second summary")

const summaries = session.entries().filter((entry) => entry.type === "compaction/summary")
if (summaries.length !== 2) {
  throw new Error(`expected two completed summaries, got ${summaries.length}`)
}
if (session.messages()[0]?.text !== "<compacted-summary>\nsecond summary\n</compacted-summary>") {
  throw new Error("second compaction did not replace the planned surface range")
}

console.log("repeated compaction acceptance passed")
