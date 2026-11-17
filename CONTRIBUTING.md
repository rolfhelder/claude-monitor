# Contributing to claude-monitor

claude-monitor records RAM and CPU use on macOS through a launchd agent. It is a personal project maintained by @rolfhelder. Bug reports, ideas and pull requests are welcome.

## Reporting Bugs

Open a [bug report](https://github.com/rolfhelder/claude-monitor/issues/new?template=bug_report.yml). A bug can only be fixed if it can be reproduced, so include:

- Claude Code version: `claude --version`
- Plugin version (from `/plugin` or the marketplace entry)
- macOS version and chip
- How you installed it (marketplace name, or a local path)
- Your plugin settings (userConfig values): `sampleSeconds`, `placement`, `detailedLogs`, `hungApps`
- The exact command you ran: `/monitor [on|off]`, `/monitor view`, `/monitor report`
- What you expected vs. what happened
- Steps to reproduce, starting from a fresh session
- Logs: Copy the last lines of `~/Library/Logs/claude-monitor/sampler.err`, plus one redacted sample line (replace process names, paths and user names with `<redacted>`).

### What not to paste

Issues are public. Do not include:

- Session content: prompts, replies, transcripts, file contents
- Tokens, API keys, cookies, or anything from your credentials
- Full process lists, especially with `detailedLogs` on: they show paths, arguments and app names
- User names, home paths and host names you would not post publicly. Replace them with `<redacted>`

Security problems do not go in issues. See [SECURITY.md](SECURITY.md).

## Feature Requests

Open a [feature request](https://github.com/rolfhelder/claude-monitor/issues/new?template=feature_request.yml). Describe the problem first, then the change you want. A request that explains who hits the problem and how often is easier to weigh.

## Submitting Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your change
3. Run the checks:

```sh
claude plugin validate .
claude plugin test .
python3 -I sampler/test_sampler.py
```

4. Open a PR with a clear description of what changed and why

Keep PRs focused: one logical change per PR. Small commits in [Conventional Commits](https://www.conventionalcommits.org/) form (`fix: ...`, `feat: ...`, `docs: ...`).

### Versioning

- Fixes bump the patch version (`1.2.3` → `1.2.4`)
- Features bump the minor version (`1.2.3` → `1.3.0`)

Update the version in `.claude-plugin/plugin.json` and add a CHANGELOG entry in the same PR.

## Code Style

- Minimal comments. Prefer clear names, and explain behavior through test names
- No issue or PR numbers in code, comments or test names
- New behavior needs a test

## Questions

Open an issue. All questions are welcome.
