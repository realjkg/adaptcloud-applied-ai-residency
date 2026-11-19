// Runs a job on an interval with the guards a collector needs: one run at a time, a pause after repeated failures,
// a pause switch, and a record of recent runs. The clock and timer are injected so tests do not wait.

export function createScheduler({ job, intervalMs, maxFailures = 3, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, history = 20 }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 60_000) throw new Error("intervalMs must be at least 60000");
  let timer = null;
  let running = false;
  let failures = 0;
  let paused = false;
  let pausedBecause = null;
  const runs = [];

  async function runOnce(trigger) {
    if (paused) return { ran: false, reason: "paused" };
    if (running) return { ran: false, reason: "already_running" };
    running = true;
    const startedAt = now().toISOString();
    try {
      const result = await job();
      const ok = result?.ok !== false;
      failures = ok ? 0 : failures + 1;
      runs.push({ trigger, startedAt, ok, ...(ok ? {} : { reason: result?.refusal ?? "failed" }) });
    } catch {
      failures += 1;
      runs.push({ trigger, startedAt, ok: false, reason: "error" });
    } finally {
      running = false;
      if (runs.length > history) runs.shift();
    }
    if (failures >= maxFailures) { paused = true; pausedBecause = "repeated_failures"; }
    return { ran: true, ...runs.at(-1) };
  }

  const arm = () => { timer = setTimer(async () => { await runOnce("schedule"); if (timer !== null) arm(); }, intervalMs); };

  return {
    start() { if (timer === null) arm(); },
    stop() { if (timer !== null) { clearTimer(timer); timer = null; } },
    runNow: () => runOnce("manual"),
    pause(reason = "manual") { paused = true; pausedBecause = reason; },
    resume() { paused = false; pausedBecause = null; failures = 0; },
    status: () => ({ scheduled: timer !== null, running, paused, pausedBecause, failures, intervalMs, runs: [...runs] })
  };
}
