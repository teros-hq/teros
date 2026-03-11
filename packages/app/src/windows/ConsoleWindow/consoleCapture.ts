/**
 * Console Capture - Captura logs de console para mostrar en UI
 */

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: number;
  level: LogLevel;
  timestamp: Date;
  args: any[];
}

type Listener = (entry: LogEntry) => void;

class ConsoleCapture {
  private logs: LogEntry[] = [];
  private listeners: Set<Listener> = new Set();
  private nextId = 1;
  private maxLogs = 500;
  private installed = false;
  private originals: Record<LogLevel, typeof console.log> = {} as any;

  install() {
    if (this.installed) return;
    this.installed = true;

    const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

    levels.forEach((level) => {
      this.originals[level] = console[level].bind(console);

      console[level] = (...args: any[]) => {
        // Llamar al original
        this.originals[level](...args);

        // Capturar
        this.capture(level, args);
      };
    });
  }

  uninstall() {
    if (!this.installed) return;
    this.installed = false;

    Object.entries(this.originals).forEach(([level, fn]) => {
      console[level as LogLevel] = fn;
    });
  }

  private capture(level: LogLevel, args: any[]) {
    const entry: LogEntry = {
      id: this.nextId++,
      level,
      timestamp: new Date(),
      args,
    };

    this.logs.push(entry);

    // Limit size
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Notificar listeners
    this.listeners.forEach((fn) => fn(entry));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
  }
}

export const consoleCapture = new ConsoleCapture();
