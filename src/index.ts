import { readFile } from "node:fs/promises";
import { runAssessment } from "./agent/workflow.js";

const path = process.argv[2] ?? "examples/client-intake.json";
const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
const result = await runAssessment(raw);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
