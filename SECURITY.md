# Security Policy

## Supported Versions

Teros is under active development. Security fixes are applied to the latest
release on the `main` branch. We do not backport fixes to older tags.

| Version | Supported |
| ------- | --------- |
| latest `main` | ✅ |
| older tags | ❌ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately:

- **GitHub Security Advisories** (preferred): open a draft advisory at
  <https://github.com/teros-hq/teros/security/advisories/new>
- **Email:** security@teros.ai

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected component, configuration).
- The version / commit you tested against.
- Any suggested remediation.

### What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity rating within 7 business days.
- Coordinated disclosure: we will agree a disclosure timeline with you and
  credit you in the advisory unless you prefer to remain anonymous.

## Threat model & scope

Teros runs untrusted-by-design workloads: AI agents execute tools, fetch
external content, and run code inside sandboxed containers. When reporting,
please distinguish between:

- **Vulnerabilities in Teros itself** — authentication/authorization bypass,
  injection, SSRF, path traversal, secret exposure, sandbox/container escape,
  remote code execution. These are in scope.
- **Inherent agent risks** — e.g. prompt injection via content an agent is
  explicitly asked to process. These are part of the threat model; hardening
  ideas are welcome, but they are not treated as classic vulnerabilities unless
  they cross a trust boundary the product promises to enforce.

## Hardening guidance for operators

If you self-host Teros, review the deployment defaults before exposing it to a
network: set strong secrets (never reuse the `.example` values), restrict CORS,
put the WebSocket/HTTP server behind an authenticating reverse proxy, bind to a
private interface where possible, and keep container images updated.
