import { expect, it } from "vitest";
import { stageStatus, stages } from "./stages";

it("shows blockers and in-progress work without counting unused branches as unfinished", () => {
  expect(stageStatus(stages[0], { schema: "complete", invalid: "dormant" })).toBe("complete");
  expect(stageStatus(stages[0], { schema: "complete", invalid: "blocked" })).toBe("blocked");
  expect(stageStatus(stages[0], { import: "complete", read: "running" })).toBe("running");
  expect(stageStatus(stages[2], { mailbox: "complete", missing: "waiting" })).toBe("waiting");
  expect(stageStatus(stages[2], { amendment: "complete", retry: "dormant", conflict: "dormant" })).toBe("complete");
  expect(stageStatus(stages[3], { calculate: "complete", review: "waiting" })).toBe("waiting");
});

it("does not report completion after only one substep or before a stage starts", () => {
  expect(stageStatus(stages[0], { import: "complete" })).toBe("queued");
  expect(stageStatus(stages[0], {})).toBe("dormant");
  expect(stageStatus(stages[1], { match: "complete", unchanged: "complete" })).toBe("complete");
});
