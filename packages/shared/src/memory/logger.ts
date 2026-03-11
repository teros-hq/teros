/**
 * Standalone logger for memory module
 * No external dependencies
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: any;
}

class Logger {
  private context: string;

  constructor(context: string = 'memory') {
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: LogContext) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${logData}`);
  }

  debug(message: string, data?: LogContext): void;
  debug(context: LogContext): void;
  debug(messageOrContext: string | LogContext, data?: LogContext) {
    if (typeof messageOrContext === 'object') {
      this.log('debug', messageOrContext.msg || '', messageOrContext);
    } else {
      this.log('debug', messageOrContext, data);
    }
  }

  info(message: string, data?: LogContext): void;
  info(context: LogContext): void;
  info(messageOrContext: string | LogContext, data?: LogContext) {
    if (typeof messageOrContext === 'object') {
      this.log('info', messageOrContext.msg || '', messageOrContext);
    } else {
      this.log('info', messageOrContext, data);
    }
  }

  warn(message: string, data?: LogContext): void;
  warn(context: LogContext): void;
  warn(messageOrContext: string | LogContext, data?: LogContext) {
    if (typeof messageOrContext === 'object') {
      this.log('warn', messageOrContext.msg || '', messageOrContext);
    } else {
      this.log('warn', messageOrContext, data);
    }
  }

  error(message: string, data?: LogContext): void;
  error(context: LogContext): void;
  error(messageOrContext: string | LogContext, data?: LogContext) {
    if (typeof messageOrContext === 'object') {
      this.log('error', messageOrContext.msg || messageOrContext.err?.message || '', messageOrContext);
    } else {
      this.log('error', messageOrContext, data);
    }
  }
}

export const logger = new Logger('memory');
export default logger;
