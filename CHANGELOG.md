# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/): fixes are patches, new features are minors.

## [1.0.1] - 2026-11-17

### Fixed
- `/monitor view` back to above the prompt no longer leaves a stale entry in the status line.

## [1.0.0] - 2026-11-17

### Added
- macOS RAM/CPU recorder: a per-user launchd agent samples every `sampleSeconds` (default 5) into `~/Library/Logs/claude-monitor/`, kept 14 days.
- Live line: RAM used (as Activity Monitor computes it), cache, swap, busy CPUs out of total, RAM pressure and CPU state; marked `stale` when the sampler stops.
- `/monitor` toggles the recorder; `on` / `off`; `report [30m|2h|3d]` summarises the worst moment and pressure alerts.
- `placement` setting and `/monitor view`: a fixed row above the prompt or the status line.
- Fast sampler: kernel counters and one `ps` per sample (a few tens of milliseconds).
- `detailedLogs` (off by default) and `hungApps` (off by default) opt-in settings.
- Self-retire: the agent removes itself if no session has used the plugin for 30 days.
- Unrecognised `/monitor` input is handed to Claude with the command's help.
