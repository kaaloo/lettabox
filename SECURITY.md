# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow: **Security → Advisories → Report a vulnerability**.

Do not open a public issue for a suspected vulnerability. Include the affected commit or version, reproduction steps, impact, and any suggested mitigation. Never include a live API key, capability token, or other credential in a report.

Security fixes target `main`; there is currently no backport policy for this pre-1.0 project.

## Security boundaries

- Letta credentials belong on the host. Use the documented Microsandbox host-side secret injection rather than copying credentials into guest images or repository files.
- The optional status server has no authentication and must remain bound to loopback. Network exposure is outside the supported configuration.
- The repository's `private/` directory is for sensitive local outputs and is intentionally gitignored.
