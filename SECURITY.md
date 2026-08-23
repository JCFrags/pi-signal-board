# Security Policy

## Supported versions

Version 0.1.x receives security fixes until a superseding supported minor release is announced.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting channel. Do not open a public issue for a suspected vulnerability. Include affected version, synthetic reproduction, impact, and redacted diagnostics. Do not include real credentials, private prompts, or proprietary source.

The maintainer should acknowledge a complete report within five business days, assign severity, and coordinate disclosure after a fix is available. No bounty is promised.

## Security boundary

Pi packages execute with the user's process permissions. Signals reduces its own authority by making no network requests, launching no processes, executing no shell commands, reading no arbitrary attachment targets, and treating attachments as inert metadata. These constraints are release requirements, not an operating-system sandbox.
