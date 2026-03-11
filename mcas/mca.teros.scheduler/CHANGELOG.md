# Changelog - Scheduler MCA

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
