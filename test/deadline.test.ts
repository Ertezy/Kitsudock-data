import { test } from "node:test";
import assert from "node:assert/strict";
import { timeIsUp } from "../src/deadline.ts";
import { ISSUES_GRACE_MS, RUN_BUDGET_MS } from "../src/validate.ts";

test("срок прогона — 10 минут от старта процесса, шаг задач получает ещё 2 минуты", () => {
  assert.equal(RUN_BUDGET_MS, 10 * 60_000);
  assert.equal(ISSUES_GRACE_MS, 2 * 60_000);
});

test("срок не задан — время не выходит никогда", () => {
  assert.equal(timeIsUp({}), false);
  assert.equal(timeIsUp({ clock: () => Number.MAX_SAFE_INTEGER }), false);
});

test("срок вышел, когда часы показывают его или больше; до этого — нет", () => {
  const at = (now: number) => ({ clock: () => now, deadline: RUN_BUDGET_MS });
  assert.equal(timeIsUp(at(0)), false);
  assert.equal(timeIsUp(at(RUN_BUDGET_MS - 1)), false);
  assert.equal(timeIsUp(at(RUN_BUDGET_MS)), true);
  assert.equal(timeIsUp(at(RUN_BUDGET_MS + 1)), true);
});

test("запас сдвигает срок: шаг задач останавливается на сроке плюс две минуты", () => {
  const at = (now: number) => ({ clock: () => now, deadline: RUN_BUDGET_MS });
  assert.equal(timeIsUp(at(RUN_BUDGET_MS + ISSUES_GRACE_MS - 1), ISSUES_GRACE_MS), false);
  assert.equal(timeIsUp(at(RUN_BUDGET_MS + ISSUES_GRACE_MS), ISSUES_GRACE_MS), true);
});

test("часы по умолчанию — performance.now: он идёт от старта процесса", () => {
  assert.equal(timeIsUp({ deadline: 0 }), true, "процесс уже работает");
  assert.equal(timeIsUp({ deadline: RUN_BUDGET_MS }), false, "тест укладывается в срок прогона");
});
