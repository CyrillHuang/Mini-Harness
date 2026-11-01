import { TuiState } from "../tui/state.js"

const state = new TuiState()
state.begin("再看看呢？仔细查看一下")

state.sync([
  { role: "user", text: "<compacted-summary>旧对话摘要</compacted-summary>" },
  { role: "assistant", text: "之前的回答" },
  { role: "user", text: "再看看呢？仔细查看一下" },
])

if (state.pendingUserText !== "") {
  throw new Error("pending user text remained after compaction reduced user count")
}

const repeated = new TuiState()
repeated.sync([{ role: "user", text: "same question" }])
repeated.begin("same question")
repeated.sync([{ role: "user", text: "same question" }])
if (repeated.pendingUserText !== "same question") {
  throw new Error("a previous identical user message cleared the pending submission")
}
repeated.sync([
  { role: "user", text: "same question" },
  { role: "user", text: "same question" },
])
if (String(repeated.pendingUserText) !== "") {
  throw new Error("pending user text remained after the new identical message was logged")
}

console.log("tui compaction user acceptance passed")
