import { describe, expect, it } from "vitest";
import { acceptPlannerInputs, answerKey, showInputs, settableInputs } from "../../src/server/agent/planner-inputs";

// Capability inputs from the planner: only the capability's listed keys, and only values the customer gave.

const said = (text: string, answers: Record<string, { value: string; label: string }> = {}) => ({ text, answers });

describe("acceptPlannerInputs", () => {
  it("drops keys the capability does not list, including inputs that lower a protection", () => {
    const r = acceptPlannerInputs("O1", [{ key: "protectedReserveMinor", value: "0" }, { key: "anything", value: "1" }], said("I have 0 reserve"));
    expect(r.inputs).toEqual({});
    expect(r.ignored).toEqual(["protectedReserveMinor", "anything"]);
    expect(acceptPlannerInputs("O8", [{ key: "savingsKeepMinor", value: "0" }], said("keep 0")).inputs).toEqual({});
    expect(acceptPlannerInputs("O9", [{ key: "keepPlayback", value: "true" }], said("keep playback")).inputs).toEqual({});
    expect(acceptPlannerInputs("E2", [{ key: "x", value: "1" }], said("1")).inputs).toEqual({});
  });

  it("keeps a number only when the customer wrote it (a *Minor field may be written in RON)", () => {
    const r = acceptPlannerInputs("O1", [{ key: "downPaymentMinor", value: "5000000" }, { key: "monthlyContributionMinor", value: "300000" }], said("I can put down 50,000 RON"));
    expect(r.inputs).toEqual({ downPaymentMinor: 5000000 });
    expect(r.ignored).toEqual(["monthlyContributionMinor"]);
    expect(acceptPlannerInputs("A6", [{ key: "months", value: "2" }], said("pause it for 2 months")).inputs).toEqual({ months: 2 });
    expect(acceptPlannerInputs("A6", [{ key: "months", value: "two" }], said("pause it for two months")).inputs).toEqual({});
  });

  it("refuses negative values and a *Minor field given in RON instead of bani", () => {
    expect(acceptPlannerInputs("O8", [{ key: "dailyFloorMinor", value: "-50000" }], said("keep at least 500 RON")).inputs).toEqual({});
    expect(acceptPlannerInputs("O8", [{ key: "dailyFloorMinor", value: "500" }], said("keep at least 500 RON")).inputs).toEqual({});
    expect(acceptPlannerInputs("O8", [{ key: "dailyFloorMinor", value: "50000" }], said("keep at least 500 RON")).inputs).toEqual({ dailyFloorMinor: 50000 });
    expect(acceptPlannerInputs("O8", [{ key: "dailyFloorMinor", value: "150000" }], said("keep at least 1.500 lei")).inputs).toEqual({ dailyFloorMinor: 150000 });
    expect(acceptPlannerInputs("O8", [{ key: "dailyFloorMinor", value: "150" }], said("keep at least 1.500 lei")).inputs).toEqual({});
    expect(acceptPlannerInputs("A6", [{ key: "months", value: "-2" }], said("pause it for 2 months")).inputs).toEqual({});
  });

  it("keeps free text only when the customer wrote it", () => {
    expect(acceptPlannerInputs("T3", [{ key: "studentIdNumber", value: "UB-2024-118" }], said("my student id is UB-2024-118")).inputs).toEqual({ studentIdNumber: "UB-2024-118" });
    expect(acceptPlannerInputs("T3", [{ key: "studentIdNumber", value: "UB-0000-001" }], said("I am a student")).inputs).toEqual({});
  });

  it("binds A17/A18/Airbag answers to the customer's answer to that capability's own question", () => {
    // The customer's request mentions stopping, but no answer to the A17 question exists: the planner cannot set it.
    expect(acceptPlannerInputs("A17", [{ key: "stillGoing", value: "no" }], said("I stopped going, no")).inputs).toEqual({});
    // An answer to another capability's question does not count.
    const a18 = { [answerKey("A18", "needsExtras")]: { value: "no", label: "No" } };
    expect(acceptPlannerInputs("A17", [{ key: "stillGoing", value: "no" }], said("No", a18)).inputs).toEqual({});
    const a17 = { [answerKey("A17", "stillGoing")]: { value: "break", label: "Taking a break" } };
    expect(acceptPlannerInputs("A17", [{ key: "stillGoing", value: "no" }], said("Taking a break", a17)).inputs).toEqual({});
    expect(acceptPlannerInputs("A17", [{ key: "stillGoing", value: "break" }], said("Taking a break", a17)).inputs).toEqual({ stillGoing: "break" });
    expect(acceptPlannerInputs("A17", [{ key: "stillGoing", value: "Taking a break" }], said("Taking a break", a17)).inputs).toEqual({ stillGoing: "break" });
    const key = "airbag_0123456789ab";
    expect(acceptPlannerInputs("O9", [{ key, value: "stop" }], said("stop it")).inputs).toEqual({});
    expect(acceptPlannerInputs("O9", [{ key, value: "stop" }], said("Pause", { [answerKey("O9", key)]: { value: "pause", label: "Pause" } })).inputs).toEqual({});
    expect(acceptPlannerInputs("O9", [{ key, value: "pause" }], said("Pause", { [answerKey("O9", key)]: { value: "pause", label: "Pause" } })).inputs).toEqual({ [key]: "pause" });
  });

  it("keeps only the roadblocks the customer's words name", () => {
    expect(acceptPlannerInputs("O6", [{ key: "roadblocks", value: "dental,rent" }], said("what if I need the dentist")).inputs).toEqual({ roadblocks: "dental" });
    expect(acceptPlannerInputs("O6", [{ key: "roadblocks", value: "rent" }], said("what if I need the dentist")).inputs).toEqual({});
  });
});

describe("showInputs and settableInputs", () => {
  it("shows labels, money, the answer's label and masks an ID", () => {
    const answers = { [answerKey("A17", "stillGoing")]: { value: "break", label: "Taking a break" } };
    expect(showInputs("A17", { stillGoing: "break" }, [], said("", answers))).toEqual([{ key: "stillGoing", label: "Still going to PulseGym", value: "Taking a break" }]);
    expect(showInputs("O1", { downPaymentMinor: 5000000 }, [], said(""))[0].value).toMatch(/50[,.]000/);
    expect(showInputs("T3", { studentIdNumber: "UB-2024-118" }, [], said(""))[0].value).toBe("•••• -118");
  });

  it("expands pattern keys from the capability's own fields", () => {
    const fields = [{ key: "airbag_0123456789ab", label: "StreamBox", type: "select" as const, value: "keep" }, { key: "keepPlayback", label: "Keep", type: "toggle" as const, value: true }];
    expect(settableInputs("O9", fields)).toEqual([{ key: "airbag_0123456789ab", source: "answer" }]);
  });
});
