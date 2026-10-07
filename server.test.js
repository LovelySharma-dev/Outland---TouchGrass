import test from "node:test"; import assert from "node:assert";
import { validate, safety } from "./server.js";
const c = { state: "surprise", energy: 30, budget: 0, social: "solo", chaos: 3 };
test("rejects bad input", () => assert.equal(validate({ state: "x" }), null));
test("accepts good input", () => assert.ok(validate(c)));
test("blocks unsafe quest", () => assert.equal(safety({ title: "A", steps: ["climb the fence", "b"], completion_condition: "x" }, c).ok, false));
test("clamps budget", () => assert.equal(safety({ title: "A", steps: ["walk", "look"], completion_condition: "x", budget: 999 }, c).quest.budget, 0));
