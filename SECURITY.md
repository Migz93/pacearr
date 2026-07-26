# Security Policy

## Reporting A Vulnerability

Please do not open a public GitHub issue for security-sensitive problems.

If you find a vulnerability in Pacearr, report it privately through GitHub's private vulnerability reporting flow for this repository if it is enabled. If that is not available, contact the maintainer directly through a private channel before disclosing details publicly.

When reporting an issue, please include:

- a short description of the problem
- the affected version or commit if known
- clear reproduction steps
- the expected impact
- any suggested mitigation if you have one

## Disclosure Expectations

- Please allow time for the issue to be investigated and fixed before public disclosure.
- I will try to acknowledge reports promptly and keep you updated on the status.
- Once a fix is available, the goal is to disclose the issue responsibly with enough detail for users to protect themselves.

## Scope

Security reports are especially helpful for issues involving:

- Plex authentication or session handling
- Plex, Sonarr, or Tautulli token exposure
- unsafe cleanup or deletion behavior
- privilege escalation
- remote code execution
- container or deployment security
- unsafe default configuration

## Supported Versions

Pacearr is still early in development. Until a stable release policy is documented, security fixes are handled on the latest supported code line.

---

## Security Scanning With Snyk

### Installation

```bash
npm install -g snyk
snyk auth
```

`snyk auth` will open a browser to authenticate against your Snyk account.

### Scan Commands

| What you're scanning | Command |
|---|---|
| Dependencies (npm packages) | `snyk test` |
| Source code (static analysis) | `snyk code test` |
| Docker image | `snyk container test pacearr` |

Run all three from the repo root (`/workspaces/pacearr`) to get full coverage.

### Philosophy — Fix Vs Ignore

We take security seriously, but we don't fix things for the sake of fixing them.

**Fix it** if:

- It's a genuine vulnerability with a realistic attack path
- The fix improves code quality or correctness
- It's straightforward to address without compromising readability or best practice

**Mark as Won't Fix** if:

- Snyk can't trace through validation logic but the code is demonstrably safe
- The "fix" would require writing worse code purely to satisfy static analysis
- The issue requires a contorted workaround that obscures intent more than it improves security

When in doubt, ask whether fixing it actually makes the code safer or just makes Snyk happy. Those are not the same thing.

### Marking Something As Won't Fix In The Snyk GUI

Use **Won't Fix** for confirmed false positives or conscious decisions not to fix. "Ignore Temporarily" implies you plan to revisit; Won't Fix signals a deliberate call.

See the [Agent Behaviour — Snyk](AGENTS.md#agent-behaviour--snyk) section in `AGENTS.md` for how agents should handle these decisions and what they should provide when recommending Won't Fix.
