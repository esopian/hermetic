# Security policy

hermetic provisions and manages infrastructure in your AWS account and handles
provider credentials and Tailscale keys, so security reports are taken
seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/esopian/hermetic/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). Include what
you found, how to reproduce it, and the version (`hermetic --version`, or the
app's About window) and commit you tested against.

You can expect an acknowledgement within a few days. Once a fix is ready it
ships in a new release, and the advisory is published with credit to the
reporter unless you ask otherwise.

## Supported versions

Only the latest release receives security fixes. The desktop app updates itself
through Check for Updates; the CLI is updated by installing the latest release.

## Scope

In scope: this repository — the CLI, the desktop app, `hermeticd`, the bootstrap
stages, and the CloudFormation foundation they deploy.

Out of scope: vulnerabilities in Hermes itself, AWS, Tailscale, or other
upstream projects (report those to their maintainers), and findings that need
an attacker to already control the operator's laptop or AWS credentials.
