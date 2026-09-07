# Security policy

This is a training repository and is not approved to process real customer, regulated, export-controlled, health, payment, or government data.

## Non-negotiable controls

- No client-side or committed secrets.
- Default-deny external tools and egress.
- Explicit human approval for consequential actions.
- Least-privilege service identities and tenant isolation.
- Prompt and retrieved content are untrusted.
- Logs contain metadata and control outcomes, not prompt bodies or sensitive content.
- Dependencies and generated artifacts require review and an SBOM before release.

Report vulnerabilities privately to the repository owner. Do not open a public issue containing exploit details or customer information.
