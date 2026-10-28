import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, waitFor, type Stack } from "./harness";

// The live planner path with a scripted stand-in for the Claude CLI (no model is called): capability inputs need the
// customer's own answer to that capability's question, the review shows them, an execution claim is withheld, and
// the CLI is started with its hardening flags.

let stack: Stack;
let dir: string;
beforeAll(async () => {
  stack = await startStack();
  dir = path.join(stack.dataDir, "fake-cli");
  fs.mkdirSync(dir, { recursive: true });
  // Picks the scenario's decision by the number of steps so far; "$available" becomes the available candidates.
  fs.writeFileSync(
    path.join(dir, "fake.mjs"),
    `import fs from "node:fs";
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(dir + "/argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
let input = "";
process.stdin.on("data", (b) => (input += b));
process.stdin.on("end", () => {
  const payload = JSON.parse(JSON.parse(input).message.content.at(-1).text);
  const scenario = JSON.parse(fs.readFileSync(dir + "/scenario.json", "utf8"));
  const d = { ...scenario[payload.history.length] };
  if (d.candidateKeys === "$available") d.candidateKeys = payload.history.filter((s) => s.tool === "analyze").at(-1).result.candidates.filter((c) => c.available).map((c) => c.key);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", structured_output: d }) + "\\n");
});
`,
  );
  fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "fake.mjs"))} "$@"\n`, { mode: 0o755 });
});
afterAll(async () => {
  await stack?.teardown();
});

const view = async (a: any, id: string, states: string[]) => waitFor(async () => {
  const v = await a.json(`/api/tasks/${id}`);
  return states.includes(v.task.state) ? v : null;
}, { timeout: 30_000, label: `task ${id} in ${states.join("/")}` });

describe("planner inputs on the live path", () => {
  it("A17: the customer's answer to the capability's own question sets stillGoing; the review lists it", async () => {
    fs.writeFileSync(
      path.join(dir, "scenario.json"),
      JSON.stringify([
        // The model tries to answer for the customer and to lower a protection-free key it may not set.
        { tool: "analyze", capabilityId: "A17", reason: "check", inputs: [{ key: "stillGoing", value: "no" }, { key: "months", value: "2" }, { key: "monthlyPriceMinor", value: "1" }] },
        { tool: "ask_user", capabilityId: "A17", inputKey: "stillGoing", question: "Shall I cancel PulseGym now?", options: ["Yes"], reason: "need answer" },
        { tool: "analyze", capabilityId: "A17", reason: "with answer", inputs: [{ key: "stillGoing", value: "break" }, { key: "months", value: "2" }] },
        { tool: "prepare_proposal", capabilityId: "A17", candidateKeys: "$available", reason: "prepare" },
        { tool: "final_answer", reason: "done", text: "I have already paused PulseGym for 2 months." },
      ]),
    );
    const a = await stack.login("alex");
    const w = await stack.worker({ env: { NEXTMOVE_PLANNER: "live", NEXTMOVE_CLAUDE_BIN: path.join(dir, "claude") } });
    try {
      const { taskId } = await a.ok("/api/tasks", { text: "I'm thinking about my PulseGym membership, maybe a freeze for 2 months" });
      const asked = await view(a, taskId, ["WAITING_USER", "FAILED", "DONE"]);
      expect(asked.task.state).toBe("WAITING_USER");
      const first = stack.q1<any>("SELECT payload_json FROM task_blocks WHERE task_id=? AND block_key='steps'", taskId)!;
      const steps = JSON.parse(first.payload_json);
      expect(steps[0].result.ignoredInputs).toEqual(["stillGoing", "monthlyPriceMinor"]);
      expect(steps[0].result.plannerInputs.map((p: any) => p.key)).toEqual(["stillGoing", "months"]);
      // The question is the capability's own wording and options, not the model's.
      const q = asked.questions.find((x: any) => x.status === "OPEN");
      expect(q.text).toBe("Are you still going to PulseGym?");
      expect(q.options).toEqual(["Yes, I still go", "Taking a break", "I stopped going"]);
      expect((await a.post(`/api/tasks/${taskId}/answer`, { questionId: q.id, answer: "Taking a break" })).status).toBe(200);

      const done = await view(a, taskId, ["NEEDS_APPROVAL", "DONE", "FAILED"]);
      expect(done.task.state).toBe("NEEDS_APPROVAL");
      expect(done.blocks.find((b: any) => b.key === "analysis:A17").payload.inputs).toEqual({ stillGoing: "break", months: 2 });
      expect(done.proposal.actions).toHaveLength(1);
      expect(done.proposal.agentInputs).toEqual([
        { key: "stillGoing", label: "Still going to PulseGym", value: "Taking a break" },
        { key: "months", label: "Freeze length (months)", value: "2" },
      ]);
      // The proposal page itself carries the same inputs.
      expect((await a.json(`/api/proposals/${done.proposal.id}`)).agentInputs).toHaveLength(2);
      const answer = done.blocks.find((b: any) => b.key === "answer").payload;
      expect(answer.text).not.toMatch(/already paused/);
      expect(answer.provenance).toMatch(/Withheld a model sentence saying "I have already paused"/);
    } finally {
      await w.stop();
    }
    const argv: string[][] = fs.readFileSync(path.join(dir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(argv.length).toBeGreaterThanOrEqual(5);
    for (const v of argv) {
      expect(v[v.indexOf("--tools") + 1]).toBe("");
      expect(v[v.indexOf("--setting-sources") + 1]).toBe("user");
      expect(v[v.indexOf("--permission-prompts") + 1]).toBe("none");
      expect(v).toContain("--strict-mcp-config");
      expect(v).not.toContain("--mcp-config");
    }
  });

  it("a free-form question cannot stand in for the capability's question", async () => {
    fs.writeFileSync(path.join(dir, "argv.jsonl"), "");
    fs.writeFileSync(
      path.join(dir, "scenario.json"),
      JSON.stringify([
        { tool: "ask_user", question: "Do you still go to PulseGym?", options: ["no", "break"], reason: "own question" },
        { tool: "analyze", capabilityId: "A17", reason: "with answer", inputs: [{ key: "stillGoing", value: "no" }] },
        { tool: "final_answer", reason: "done", text: "Nothing happens until you approve." },
      ]),
    );
    const a = await stack.login("alex");
    const w = await stack.worker({ env: { NEXTMOVE_PLANNER: "live", NEXTMOVE_CLAUDE_BIN: path.join(dir, "claude") } });
    try {
      const { taskId } = await a.ok("/api/tasks", { text: "What about PulseGym?" });
      const asked = await view(a, taskId, ["WAITING_USER", "FAILED", "DONE"]);
      const q = asked.questions.find((x: any) => x.status === "OPEN");
      await a.ok(`/api/tasks/${taskId}/answer`, { questionId: q.id, answer: "no" });
      const done = await view(a, taskId, ["NEEDS_APPROVAL", "DONE", "FAILED"]);
      expect(done.task.state).toBe("DONE");
      expect(done.blocks.find((b: any) => b.key === "analysis:A17").payload.inputs).toEqual({});
      expect(done.blocks.find((b: any) => b.key === "answer").payload.text).toBe("Nothing happens until you approve.");
    } finally {
      await w.stop();
    }
  });

  it("the final answer cannot vouch for its own invented number", async () => {
    fs.writeFileSync(
      path.join(dir, "scenario.json"),
      JSON.stringify([
        { tool: "analyze", capabilityId: "A17", reason: "check" },
        { tool: "final_answer", reason: "done", text: "You would save 987.65 RON." },
      ]),
    );
    const a = await stack.login("alex");
    const w = await stack.worker({ env: { NEXTMOVE_PLANNER: "live", NEXTMOVE_CLAUDE_BIN: path.join(dir, "claude") } });
    try {
      const { taskId } = await a.ok("/api/tasks", { text: "Is PulseGym worth it?" });
      const done = await view(a, taskId, ["NEEDS_APPROVAL", "DONE", "FAILED"]);
      const answer = done.blocks.find((b: any) => b.key === "answer").payload;
      expect(answer.text).not.toMatch(/987/);
      expect(answer.provenance).toMatch(/Withheld a model sentence citing 987\.65/);
    } finally {
      await w.stop();
    }
  });
});
