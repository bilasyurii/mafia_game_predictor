import { test } from "node:test";
import assert from "node:assert/strict";
import { describeGameEvent } from "./describeGameEvent";
import { CandidateVote, KeepOrEliminateVote } from "./types";

test("candidateVote description shows who raised a hand against each candidate", () => {
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["1", "2", "3"],
    handsRaised: { "1": ["4", "5"], "2": ["6"] },
  };
  assert.equal(describeGameEvent(vote), "vote (initial): 1 <- 4, 5; 2 <- 6; 3 <- (nobody)");
});

test("keepOrEliminateVote description shows who voted to eliminate", () => {
  const vote: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["1", "2"],
    eliminateHands: ["3", "4"],
  };
  assert.equal(
    describeGameEvent(vote),
    "keep/eliminate vote: candidates=[1,2], voted to eliminate: 3, 4"
  );
});

test("no hands raised for a candidate renders as (nobody)", () => {
  const vote: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["1", "2"],
    eliminateHands: [],
  };
  assert.equal(
    describeGameEvent(vote),
    "keep/eliminate vote: candidates=[1,2], voted to eliminate: (nobody)"
  );
});
