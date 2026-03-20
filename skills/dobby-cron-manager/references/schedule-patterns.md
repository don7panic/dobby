# Schedule Patterns

## Rules of thumb

- Prefer `--at` for one-time jobs.
- Prefer `--cron` for recurring jobs tied to calendar time.
- Use `--every-ms` only for exact interval jobs or when the user explicitly asks for millisecond cadence.
- Add `--tz` whenever the intended wall-clock timezone matters.

## Common mappings

- "run once today at 18:00" -> `--at 2026-03-20T18:00:00+08:00`
- "every weekday at 09:00" -> `--cron "0 9 * * 1-5" --tz Asia/Shanghai`
- "every day at midnight" -> `--cron "0 0 * * *"`
- "every Monday at 10:30" -> `--cron "30 10 * * 1"`
- "every 15 minutes" -> `--cron "*/15 * * * *"`
- "every hour" -> `--cron "0 * * * *"`
- "every 30 seconds" -> do not use cron; only use `--every-ms 30000` if that cadence is truly intended

## Ambiguity checklist

Ask a short follow-up question when any of these are missing or unclear:

- timezone
- one-time vs recurring intent
- run once now vs resume future schedule
- delivery target when multiple bindings exist
- prompt text for the job itself

## Reply format guidance

When you convert a natural-language schedule, always restate it in concrete form. Example:

- "I interpreted this as weekdays at 09:00 in Asia/Shanghai."
- "I interpreted this as one run on 2026-03-20 18:00 +08:00."
