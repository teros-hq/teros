# Changelog - Scheduler MCA

## [1.1.0] - 2026-05-22 - User Isolation (TER-358)

### 🔒 Security — cierre de la cadena de exploit cross-user

El audit de seguridad sobre la v1.0.0 detectó 5 CRITICAL que formaban una
cadena de RCE persistente cross-user. Esta versión los cierra con defensa
en profundidad en 4 capas independientes.

- **C-1 Wake-up cross-user con RCE**: cerrado. `mca-callback-routes.handleChannelSubscription` valida que `body.channelId` pertenece al user del callback token (Capa 2). `scheduler-service.ts` verifica `channel.userId === reminder.user_id` antes de cada dispatch (Capa 3). `mca-event-subscription-service.dispatch` re-valida `payload.userId === channel.userId` antes del wake-up (Capa 4).
- **C-2 Lectura cross-user**: cerrado. Todas las queries (`listReminders`, `listRecurringTasks`, `list-upcoming`, `list-executions`, `get-reminder`, `get-recurring-task`, `get-stats`) exigen `userId` REQUIRED y filtran al level Mongo.
- **C-3 Mutación cross-user no atómica**: cerrado. `cancelReminder`, `updateReminder`, `bulkCancelReminders`, `setRecurringEnabled`, `deleteRecurringTask`, `updateRecurringTask` usan `findOneAndUpdate`/`findOneAndDelete` con filter compuesto `{id, user_id, status?}` en una sola query atómica. Sin TOCTOU.
- **C-4 IDs secuenciales globales**: cerrado. `scheduler_counters` ahora usa `_id: '<reminders|recurring_tasks>:<userId>'` — counter per-user. Ids cortos en prompts del LLM preservados.
- **C-5 WsRouter simétricamente roto**: cerrado. `handlers/domains/scheduler/{_helpers,handlers,store}.ts` consumen `ctx.userId` en cada operación; espejo exacto del MCA (criterio 22).

### 📦 Schema

- Añadido `user_id: string` REQUIRED y `workspace_id?: string` opcional a `Reminder`, `RecurringTask`, `Execution`.
- Tipos canónicos movidos a `packages/shared/src/scheduler.ts` (elimina la triple duplicación entre `db.ts`, `_helpers.ts` y `scheduler-service.ts`).
- Composite indexes nuevos: `{user_id, status, scheduled_time}`, `{user_id, channel_id}`, `{user_id, enabled, next_run}`, `{user_id, task_id, ran_at:-1}`. Índices globales del executor se mantienen.

### 🛠️ Migration `user_id_backfill_v1`

`db.connect()` ejecuta una migration idempotente vía la collection `scheduler_migrations`:

1. Para cada doc sin `user_id`: lookup `channels.findOne({_id: channel_id})` → `set user_id = channel.userId` (y `workspace_id` si existe).
2. Channel huérfano (borrado o sin userId) → `set user_id = '__orphaned__'`.
3. Idempotente: dos contenedores arrancando simultáneo solo procesan una vez.

Sentinel `__orphaned__` excluido en queries normales y en el find del executor — los huérfanos nunca disparan.

### ✨ UX

- **Permission widget** ahora muestra descripción humana para las 19 tools del scheduler (cierra compliance #17). Las destructive (cancel, bulk-cancel, delete) llevan badge `irreversible`.
- `channelId` validado con regex `^ch_[0-9a-f]{16}$` en boundary del handler.
- `message` cap explícito a 4000 chars (evita storage/token exhaustion).
- Tools de create (`schedule-reminder`, `create-recurring-task`) verifican ownership del channel via `context.backend.channelGet` antes de persistir.
- Cleanup unificado de subscriptions: `cancel-reminder` y `delete-recurring-task` limpian ambos topics (`scheduler.reminder` y `scheduler.recurring_task`); `bulk-cancel` deduplica channels y limpia subs huérfanas.

### 🧪 Tests

- `test/isolation.test.ts` (13 tests): 2 users, cross-user list/get/mutate todos rechazados.
- `test/migration.test.ts` (5 tests): backfill, idempotencia, orphan handling, cascada executions.
- `test/ownership-atomic.test.ts` (12+ tests): race conditions cerradas, atomic compare-and-set, guards `status:'pending'` y `enabled:true`.
- Total: 81/81 tests passing (36 originales + 45 nuevos).

### 🔧 Robustez del executor (incluida en este PR)

Atendiendo al bug reportado en paralelo ("recurring task no manda emails"):

- **Subscription auto-recreate**: `MCAEventSubscriptionService.dispatch` ahora retorna `{channelMatched, agentMatched}`. Si el scheduler detecta `matched === 0` para `scheduler.*`, re-crea la subscription via `createChannelSubscription` y reintenta el dispatch una vez. Cubre el caso de TTL expiration silente.
- **Atomic claim**: reminders pasan a `status: 'dispatching'` antes del dispatch via `findOneAndUpdate` CAS. Cierra double-dispatch (audit robustez C-1) y permite reaper futuro de docs huérfanos en `dispatching`.
- **isChecking guard + setTimeout recursivo**: el siguiente tick se agenda en el `finally` del actual. Cero iteraciones solapadas (audit C-2).
- **next_run avanza en `finally`**: incluso si el dispatch falla, `next_run` se avanza al siguiente ciclo. Sin atascos (audit C-3). `consecutive_failures` se incrementa; tras `RECURRING_FAILURE_CAP = 5` la task se deshabilita con log + Sentry.
- **fail-loud cron**: si `getNextCronRun` lanza o devuelve null (ej. `0 31 2 * *` Feb-31), la task se deshabilita con `last_error: 'cron: …'`. Sin fallback silencioso a +1h (audit C-4).
- **`recordExecution` wire-up**: cada iteración del executor registra una Execution (`success`/`failure` + error). La tool `list-executions` deja de ser feature muerta (audit m-7).
- **MongoClient con retry opts**: `retryWrites`, `retryReads`, `serverSelectionTimeoutMS: 5000`, `maxPoolSize: 10`.
- **TTL index para reminders terminales**: documentos con `terminal_at` (sent/cancelled/failed) se purgan tras `TERMINAL_REMINDER_TTL_SECONDS = 30 días`.
- **Status `'dispatching'`** añadido a `ReminderStatus` para audit visibility.

### ⏩ Follow-ups bajo TER-186

- **Mongo direct → `context.backend`** (PR2, mini-RFC): elimina patch dev-only macOS, deja MCA portable.
- **Reaper de docs huérfanos en `dispatching`**: tras crash del executor entre claim y mark, el doc queda en `dispatching`. Un reaper periódico debe revivirlos o marcarlos failed según TTL.
- **Mejoras cosméticas TER-186** (PR3): `verb=` API en SchedulerToolShell, color tokens v2 en destructive renderers, idempotency declarativa.

---

## [2.0.0] - MongoDB Migration

### 🎯 Breaking Changes

- **Database**: Migrated from SQLite to MongoDB
- **All database operations are now asynchronous**
- **Field change**: `RecurringTask.enabled` changed from `number` (0/1) to `boolean` (true/false)

### ✨ New Features

- MongoDB support with connection pooling
- Auto-increment ID system using MongoDB counters
- Optimized indexes for better query performance
- Environment variable configuration for MongoDB connection

### 🔧 Technical Changes

#### Dependencies
- **Added**: `mongodb@^6.12.0`
- **Removed**: Implicit dependency on `bun:sqlite`

#### Files Modified

**`src/db.ts`**
- Complete rewrite using MongoDB driver
- All methods converted to async/await
- Added `connect()` method for database initialization
- Implemented counter-based auto-increment for IDs
- Created indexes: `status+scheduled_time`, `channel_id`, `enabled+next_run`
- Maintains backward compatibility with numeric IDs

**`src/index.ts`**
- Added `await db.connect()` on startup
- Converted all database calls to async with `await`
- Updated `checkReminders()` to async
- Updated `checkRecurringTasks()` to async
- Updated signal handlers (SIGINT, SIGTERM) to properly close async connection
- Enhanced `formatRecurringTask()` to handle both boolean and number for `enabled` field

**`package.json`**
- Added `mongodb` dependency

### 📦 MongoDB Collections

1. **`scheduler_reminders`**
   - Stores one-time reminders
   - Indexes: `{status: 1, scheduled_time: 1}`, `{channel_id: 1}`, `{id: 1}`

2. **`scheduler_recurring_tasks`**
   - Stores cron-based recurring tasks
   - Indexes: `{enabled: 1, next_run: 1}`, `{channel_id: 1}`, `{id: 1}`

3. **`scheduler_counters`**
   - Manages auto-increment sequences
   - Documents: `reminders`, `recurring_tasks`

### ⚙️ Configuration

New environment variables:
```bash
MONGODB_URI=mongodb://localhost:27017  # Default
MONGODB_DB_NAME=teros                   # Default
```

### 🔄 Migration Path

For users upgrading from SQLite:
1. See `MIGRATION.md` for detailed migration guide
2. Optional data migration script provided
3. SQLite database is no longer used

### 🧪 Testing

- Added `test-connection.ts` script to verify MongoDB connectivity
- Run: `bun run test-connection.ts`

### 📝 API Compatibility

**MCP Tools remain unchanged:**
- ✅ `schedule_reminder` - Same interface
- ✅ `list_reminders` - Same interface
- ✅ `cancel_reminder` - Same interface
- ✅ `create_recurring_task` - Same interface
- ✅ `list_recurring_tasks` - Same interface
- ✅ `enable_recurring_task` - Same interface
- ✅ `disable_recurring_task` - Same interface
- ✅ `delete_recurring_task` - Same interface

### 🚀 Performance Improvements

- Better concurrency handling
- Optimized queries with proper indexes
- Scalable for larger datasets
- Connection pooling for better resource usage

### 📚 Documentation

- Added `MIGRATION.md` with complete migration guide
- Added troubleshooting section
- Added data migration script example

---

## [1.0.0] - Initial Release (SQLite)

### Features
- Schedule one-time reminders
- Create recurring tasks with cron expressions
- Natural language time parsing
- MCP server integration
- SQLite database storage
