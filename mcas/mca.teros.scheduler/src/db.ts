import { type Collection, type Db, MongoClient, type ObjectId } from 'mongodb';

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'teros';

export interface Reminder {
  _id?: ObjectId;
  id?: number; // For backward compatibility
  channel_id: string;
  message: string;
  scheduled_time: number;
  created_at: number;
  status: 'pending' | 'sent' | 'cancelled';
}

export interface RecurringTask {
  _id?: ObjectId;
  id?: number; // For backward compatibility
  channel_id: string;
  message: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_run?: number;
  next_run: number;
  created_at: number;
}

export class SchedulerDB {
  private client: MongoClient;
  private db!: Db;
  private reminders!: Collection<Reminder>;
  private recurringTasks!: Collection<RecurringTask>;
  private connected: boolean = false;
  private counterCollection!: Collection<{
    _id: string;
    seq: number;
  }>;

  constructor() {
    this.client = new MongoClient(MONGODB_URI);
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect();
    this.db = this.client.db(DB_NAME);
    this.reminders = this.db.collection<Reminder>('scheduler_reminders');
    this.recurringTasks = this.db.collection<RecurringTask>('scheduler_recurring_tasks');
    this.counterCollection = this.db.collection<{
      _id: string;
      seq: number;
    }>('scheduler_counters');

    await this.init();
    this.connected = true;
  }

  private async init(): Promise<void> {
    // Create indexes for reminders
    await this.reminders.createIndex({
      status: 1,
      scheduled_time: 1,
    });
    await this.reminders.createIndex({
      channel_id: 1,
    });
    await this.reminders.createIndex(
      {
        id: 1,
      },
      {
        unique: true,
        sparse: true,
      },
    );

    // Create indexes for recurring tasks
    await this.recurringTasks.createIndex({
      enabled: 1,
      next_run: 1,
    });
    await this.recurringTasks.createIndex({
      channel_id: 1,
    });
    await this.recurringTasks.createIndex(
      {
        id: 1,
      },
      {
        unique: true,
        sparse: true,
      },
    );

    // Initialize counters if they don't exist
    await this.counterCollection.updateOne(
      {
        _id: 'reminders',
      },
      {
        $setOnInsert: {
          seq: 0,
        },
      },
      {
        upsert: true,
      },
    );
    await this.counterCollection.updateOne(
      {
        _id: 'recurring_tasks',
      },
      {
        $setOnInsert: {
          seq: 0,
        },
      },
      {
        upsert: true,
      },
    );
  }

  private async getNextSequence(name: string): Promise<number> {
    const result = await this.counterCollection.findOneAndUpdate(
      {
        _id: name,
      },
      {
        $inc: {
          seq: 1,
        },
      },
      {
        returnDocument: 'after',
        upsert: true,
      },
    );
    return result?.seq || 1;
  }

  async createReminder(
    channelId: string,
    message: string,
    scheduledTime: number,
  ): Promise<Reminder> {
    const id = await this.getNextSequence('reminders');
    const reminder: Reminder = {
      id,
      channel_id: channelId,
      message,
      scheduled_time: scheduledTime,
      created_at: Date.now(),
      status: 'pending',
    };

    const result = await this.reminders.insertOne(reminder);
    reminder._id = result.insertedId;

    return reminder;
  }

  async getPendingReminders(): Promise<Reminder[]> {
    return await this.reminders
      .find({
        status: 'pending',
        scheduled_time: {
          $lte: Date.now(),
        },
      })
      .sort({
        scheduled_time: 1,
      })
      .toArray();
  }

  async getAllReminders(channelId?: string): Promise<Reminder[]> {
    const query: Partial<Reminder> = {
      status: 'pending',
    };
    if (channelId) {
      query.channel_id = channelId;
    }

    return await this.reminders
      .find(query)
      .sort({
        scheduled_time: 1,
      })
      .toArray();
  }

  async markAsSent(id: number): Promise<void> {
    await this.reminders.updateOne(
      {
        id,
      },
      {
        $set: {
          status: 'sent',
        },
      },
    );
  }

  async cancelReminder(id: number): Promise<boolean> {
    const result = await this.reminders.updateOne(
      {
        id,
        status: 'pending',
      },
      {
        $set: {
          status: 'cancelled',
        },
      },
    );
    return result.modifiedCount > 0;
  }

  async getReminder(id: number): Promise<Reminder | null> {
    return await this.reminders.findOne({
      id,
    });
  }

  async close(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }

  // Recurring tasks methods
  async createRecurringTask(
    channelId: string,
    message: string,
    cronExpression: string,
    nextRun: number,
    timezone: string = 'Europe/Madrid',
  ): Promise<RecurringTask> {
    const id = await this.getNextSequence('recurring_tasks');
    const task: RecurringTask = {
      id,
      channel_id: channelId,
      message,
      cron_expression: cronExpression,
      timezone,
      enabled: true,
      next_run: nextRun,
      created_at: Date.now(),
    };

    const result = await this.recurringTasks.insertOne(task);
    task._id = result.insertedId;

    return task;
  }

  async getDueRecurringTasks(): Promise<RecurringTask[]> {
    return await this.recurringTasks
      .find({
        enabled: true,
        next_run: {
          $lte: Date.now(),
        },
      })
      .sort({
        next_run: 1,
      })
      .toArray();
  }

  async getAllRecurringTasks(channelId?: string): Promise<RecurringTask[]> {
    const query: Partial<RecurringTask> = {};
    if (channelId) {
      query.channel_id = channelId;
    }

    return await this.recurringTasks
      .find(query)
      .sort({
        next_run: 1,
      })
      .toArray();
  }

  async updateRecurringTaskNextRun(id: number, nextRun: number, lastRun: number): Promise<void> {
    await this.recurringTasks.updateOne(
      {
        id,
      },
      {
        $set: {
          next_run: nextRun,
          last_run: lastRun,
        },
      },
    );
  }

  async enableRecurringTask(id: number): Promise<boolean> {
    const result = await this.recurringTasks.updateOne(
      {
        id,
      },
      {
        $set: {
          enabled: true,
        },
      },
    );
    return result.modifiedCount > 0;
  }

  async disableRecurringTask(id: number): Promise<boolean> {
    const result = await this.recurringTasks.updateOne(
      {
        id,
      },
      {
        $set: {
          enabled: false,
        },
      },
    );
    return result.modifiedCount > 0;
  }

  async deleteRecurringTask(id: number): Promise<boolean> {
    const result = await this.recurringTasks.deleteOne({
      id,
    });
    return result.deletedCount > 0;
  }

  async getRecurringTask(id: number): Promise<RecurringTask | null> {
    return await this.recurringTasks.findOne({
      id,
    });
  }
}
