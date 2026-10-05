# Security Policy

## Supported versions

OpenWork is under active development and we prioritize fixes on the latest release and
the current `dev` branch.

## Reporting a vulnerability

Please do not open public GitHub issues for security vulnerabilities.

Instead, report vulnerabilities privately to:

- Email: `ben@openworklabs.com`
- Subject: `[OpenWork security] <short summary>`

> **This is a fork.** It is not operated by Different AI, Inc., so that address
> reaches the upstream vendor and not whoever runs this deployment. For a fork
> you maintain, point this at your own security contact — or use GitHub's
> private vulnerability reporting on the fork's repository, which keeps the
> report off the public issue tracker.

## Threat model for this fork

Worth stating explicitly, because the hosted product's assumptions no longer
apply:

- **`openwork-server` authorizes anything that can reach its port.** It injects
  a valid client token into the page it serves for *any* `Host` header and never
  sends the privileged host token to the browser. Keep it on loopback, or behind
  an authenticating reverse proxy. Do not bind it to `0.0.0.0`.
- **There is no account system.** No sign-in means no session theft through a
  credential, but it also means no per-user isolation. One shared deployment is
  one shared trust boundary.
- **Third-party model providers and MCP servers see your prompts and files.**
  They are the real egress surface, and the ones worth reviewing are the ones you
  configured. The full inventory is in
  [`docs/enterprise/outbound-access.json`](./docs/enterprise/outbound-access.json).

Please include:

- A clear description of the issue
- Reproduction steps or proof of concept
- Impact assessment
- Suggested remediation (if known)

## Response expectations

- We will acknowledge receipt within 3 business days.
- We will provide an initial triage status within 7 business days.
- We will share remediation or mitigation guidance as soon as available.

## Disclosure guidance

Please keep details private until a fix or mitigation is available and maintainers
confirm public disclosure timing.
