# Security policy

This is a training repository and is not approved to process real customer, regulated, export-controlled, health, payment, or government data.

## Non-negotiable controls

- No client-side or committed secrets.
- Default-deny external tools and egress. The MCP connector layer in `src/platform/mcp/` ships disabled in every reference profile, refuses any endpoint that is not an allowlisted public https host, blocks private, loopback, link-local, and instance-metadata addresses ahead of the allowlist, and has no live transport. See `docs/MCP_CONNECTORS.md`.
- Connector and model tool results are untrusted input. They inform a recommendation and never change a finding, a severity, or an approval state.
- Explicit human approval for consequential actions.
- Least-privilege service identities and tenant isolation.
- Prompt and retrieved content are untrusted.
- Logs contain metadata and control outcomes, not prompt bodies or sensitive content.
- Dependencies and generated artifacts require review and an SBOM before release.
- Production starts only when the runtime readiness policy has no blocking findings.
- `AUTH_MODE=gateway` requires private ingress; untrusted callers must not be able to set the authenticated-subject header.
- Model failure or timeout falls back to deterministic behavior and cannot bypass a control.

The container runs as a non-root user and contains compiled runtime artifacts only. The reference production environment file contains non-secret controls; actual credentials must be injected at runtime and rotated by the hosting platform.

Report vulnerabilities privately to the repository owner. Do not open a public issue containing exploit details or customer information.
