# MCA Scheduler

A scheduled messages and reminders system. When the time comes, it sends a message to the specified channel. The agent receives the message and decides what to do with it, just like any other message.

## How it works

1. A reminder is scheduled with a message and a time
2. When the time comes, the scheduler sends the message to the channel
3. The agent receives it and acts according to its criteria

## Use cases

- One-time reminders ("remind me to review X tomorrow at 9")
- Periodic tasks ("every Monday at 10, check open PRs")
- Scheduled checks ("every hour, look for errors in Sentry")

## Tools

### One-time reminders

#### `schedule_reminder`
Schedules a message for a specific time.

- `time`: Time expression (see formats below)
- `message`: The message to send
- `channelId`: Target channel

**Time formats:**
- `"at 17:00"` or `"at 5:30pm"` - specific time today (or tomorrow if already past)
- `"tomorrow at 9:00"` - tomorrow at a specific time
- `"in 30 minutes"` / `"in 2 hours"` - relative time
- `"2025-10-28T17:00:00"` - ISO 8601 format

#### `list_reminders`
Lists pending reminders.

#### `cancel_reminder`
Cancels a reminder by ID.

### Recurring tasks

#### `create_recurring_task`
Creates a task that repeats according to a cron expression.

- `cronExpression`: Cron expression (5 fields: minute hour day month weekday)
- `message`: The message to send each time
- `channelId`: Target channel
- `timezone` (optional): Timezone (default: "Europe/Madrid")

**Cron examples:**
- `"0 9 * * *"` - Daily at 9:00
- `"0 9 * * 1-5"` - Weekdays at 9:00
- `"*/15 * * * *"` - Every 15 minutes

#### `list_recurring_tasks`
Lists recurring tasks.

#### `enable_recurring_task` / `disable_recurring_task`
Pauses or reactivates a recurring task.

#### `delete_recurring_task`
Deletes a recurring task.

## Database

Uses MongoDB. Collections:
- `scheduler_reminders` - One-time reminders
- `scheduler_recurring_tasks` - Recurring tasks

## Environment variables

- `MONGODB_URI` - MongoDB connection (default: `mongodb://localhost:27017`)
- `MONGODB_DB_NAME` - Database name (default: `teros`)
- `TEROS_API_URL` - API URL to send messages (default: `http://localhost:3000`)

## Internal workings

The scheduler checks every 30 seconds for reminders or tasks that need to be executed. When it finds one, it sends the message to the `/api/event` endpoint.
