// Structured JSON logger for all agent workers

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  agent: string;
  workflow_id?: string;
  task?: string;
  duration_ms?: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  external_api?: string;
  external_api_status?: number;
  result?: 'success' | 'failure' | 'partial';
  error?: string;
  approval_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export class Logger {
  constructor(private readonly agentName: string) {}

  private log(level: LogLevel, message: string, fields: Partial<LogEntry> = {}): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      agent: this.agentName,
      message,
      ...fields,
    };
    // Cloudflare Workers — console.log is captured by Logpush
    console.log(JSON.stringify(entry));
  }

  info(message: string, fields?: Partial<LogEntry>): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: Partial<LogEntry>): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: Partial<LogEntry>): void {
    this.log('error', message, fields);
  }

  debug(message: string, fields?: Partial<LogEntry>): void {
    this.log('debug', message, fields);
  }

  taskStart(workflowId: string, task: string): number {
    this.info(`Task started: ${task}`, { workflow_id: workflowId, task });
    return Date.now();
  }

  taskEnd(workflowId: string, task: string, startedAt: number, fields: Partial<LogEntry> = {}): void {
    this.info(`Task completed: ${task}`, {
      workflow_id: workflowId,
      task,
      duration_ms: Date.now() - startedAt,
      result: 'success',
      ...fields,
    });
  }

  taskFailed(workflowId: string, task: string, startedAt: number, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.error(`Task failed: ${task}`, {
      workflow_id: workflowId,
      task,
      duration_ms: Date.now() - startedAt,
      result: 'failure',
      error: errorMessage,
    });
  }
}
