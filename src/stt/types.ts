export type ProgressInfo = {
  status: 'downloading' | 'ready' | 'error';
  name?: string;
  progress?: number;
  error?: Error;
};

export type WorkerMessage =
  | { type: 'progress'; status: string; name?: string; progress?: number }
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'result'; text: string }
  | { type: 'log'; message: string };

export type WorkerCommand =
  | { type: 'init'; cacheDir: string; model: string }
  | { type: 'transcribe'; audioPath: string };
