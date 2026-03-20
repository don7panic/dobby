# Command Map

## Inspect configuration and jobs

```bash
dobby config show bindings --json
dobby config show routes --json
dobby config show connectors --json
dobby cron list --json
dobby cron status <jobId> --json
```

Use config inspection first when the user gives a natural-language request that does not yet include connector, route, or channel details.

## Create a job

```bash
dobby cron add <name> \
  --prompt <text> \
  --connector <id> \
  --route <id> \
  --channel <id> \
  [--thread <id>] \
  (--at <iso> | --every-ms <ms> | --cron <expr>) \
  [--tz <iana-timezone>] \
  [--cron-config <path>]
```

## Update a job

```bash
dobby cron update <jobId> \
  [--name <name>] \
  [--prompt <text>] \
  [--connector <id>] \
  [--route <id>] \
  [--channel <id>] \
  [--thread <id> | --clear-thread] \
  [--at <iso> | --every-ms <ms> | --cron <expr>] \
  [--tz <iana-timezone>] \
  [--cron-config <path>]
```

## Control job state

```bash
dobby cron pause <jobId>
dobby cron resume <jobId>
dobby cron run <jobId>
dobby cron remove <jobId>
```

## Semantics to preserve in replies

- `pause` disables future scheduled runs.
- `resume` re-enables future scheduled runs and recomputes the next scheduled run.
- `run` queues one immediate execution and does not resume a paused job.
- `remove` deletes the job from the cron store.
- `status` is the safest post-mutation verification command for one job.
- `list` is the safest summary command when the user wants the whole schedule table.
