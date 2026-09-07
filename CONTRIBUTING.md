# Contributing

1. Select a bounded onboarding issue.
2. Create a branch named `resident/<issue>-<short-name>`.
3. Write the acceptance test first.
4. Make the smallest change that satisfies the acceptance criteria.
5. Run `npm run check && npm test && npm run eval && npm run readiness:production-reference`.
6. Open a pull request using the supplied template.
7. Include customer value, security effect, cost effect, evidence, residual risk, and rollback.

Model-generated code receives the same review as human-authored code.

Changes to a scenario or shared platform must update its service-level assumptions and identify the effect on all six pillars in `docs/WELL_ARCHITECTED.md`. Do not solve a reliability problem with unbounded retries or a cost problem by weakening a safety control.
