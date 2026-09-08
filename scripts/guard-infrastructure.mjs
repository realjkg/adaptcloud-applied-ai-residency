const environments = new Set(["sandbox", "staging", "production"]);
const operations = new Set(["plan", "apply", "destroy"]);

export function evaluateInfrastructureGuard(environment, operation, confirmation = "") {
  if (!environments.has(environment)) return { allowed: false, reason: "unsupported environment" };
  if (!operations.has(operation)) return { allowed: false, reason: "unsupported operation" };
  if (operation === "plan") return { allowed: true, reason: "reviewed plans are allowed for every environment" };
  if (environment !== "sandbox") return { allowed: false, reason: "only sandbox can be mutated by this repository" };
  const expected = operation === "apply" ? "APPLY MY SANDBOX" : "DESTROY MY SANDBOX";
  if (confirmation !== expected) return { allowed: false, reason: `${operation} confirmation did not match` };
  return { allowed: true, reason: `student-owned sandbox ${operation} explicitly confirmed` };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = evaluateInfrastructureGuard(
    process.env.TARGET_ENVIRONMENT ?? "",
    process.env.OPERATION ?? "",
    process.env.CONFIRMATION ?? ""
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.allowed) process.exitCode = 1;
}
