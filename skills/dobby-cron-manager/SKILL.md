---
name: dobby-cron-manager
description: Manage dobby cron jobs from natural-language requests by translating user intent into `dobby cron` CLI commands and related config inspection. Use when Codex needs to create, inspect, update, pause, resume, run, or remove dobby cron jobs, including Chinese requests such as `创建定时任务`, `修改 cron`, `暂停任务`, `恢复任务`, or `立即跑一次`.
---

# Dobby Cron Manager

Manage dobby cron jobs through the existing CLI instead of editing cron store files by hand.

## Quick workflow

1. Inspect current context before mutating anything.
2. Resolve the user's intent into one cron command.
3. Resolve delivery target, schedule, and prompt.
4. Run the CLI command.
5. Verify with `status` or `list` and report the exact job ID and resulting state.

## Inspect context first

Run these commands before creating or changing jobs:

```bash
dobby config show bindings --json
dobby config show routes --json
dobby config show connectors --json
dobby cron list --json
```

Use `dobby cron status <jobId> --json` when the user names an existing job.

If the user works through `provider.pi`, make sure the PI provider can see this skill. Prefer configuring `providers.items.<id>.config.agentDir` to the agent home that contains this skill.

## Map user intent to one command

- Create a new job -> `dobby cron add`
- Inspect all jobs -> `dobby cron list`
- Inspect one job -> `dobby cron status <jobId>`
- Change prompt, schedule, or delivery -> `dobby cron update <jobId>`
- Pause future scheduled runs -> `dobby cron pause <jobId>`
- Resume future scheduled runs -> `dobby cron resume <jobId>`
- Trigger one immediate execution without changing schedule state -> `dobby cron run <jobId>`
- Delete a job -> `dobby cron remove <jobId>`

Treat "start" as ambiguous until context makes it clear:

- If the user means "enable the job again," use `resume`.
- If the user means "run it once now," use `run`.

## Resolve delivery safely

A new job needs:

- `--connector`
- `--route`
- `--channel`
- optional `--thread`

Prefer these resolution rules:

1. Use explicit user input when provided.
2. If exactly one binding exists, derive defaults from it:
   - `connector = binding.connector`
   - `channel = binding.source.id`
   - `route = binding.route`
3. If multiple bindings exist and the user did not specify a target, ask one concise follow-up question.

Do not invent connector IDs, route IDs, channel IDs, or thread IDs.

## Resolve schedules conservatively

- Use `--at <iso>` for one-time jobs.
- Use `--cron <expr>` for calendar schedules such as daily, weekly, or weekday patterns.
- Use `--every-ms <ms>` only when the user explicitly wants a fixed interval or millisecond-based cadence.
- Add `--tz <iana-name>` for cron schedules whenever timezone matters.

Convert relative requests into concrete timestamps before using `--at`. Use absolute dates and times in the reply so the user can verify the interpretation.

If the schedule is ambiguous, ask one short question instead of guessing.

Read `references/schedule-patterns.md` for common mappings.

## Prefer CLI over manual edits

Do not write `cron-jobs.json` or `cron-runs.jsonl` directly unless you are debugging a broken local install. The CLI is the source of truth for normal operations.

Read `references/command-map.md` for exact command shapes and post-mutation checks.

## Verify every mutation

After `add`, `update`, `pause`, `resume`, `run`, or `remove`:

- verify with `dobby cron status <jobId> --json` or `dobby cron list --json`
- report the exact job ID
- explain whether the job is enabled, paused, or only queued for one immediate run

When `run` is used, remind the user that it only queues one execution and does not change the job's enabled state. The gateway process must be running for execution to happen.
