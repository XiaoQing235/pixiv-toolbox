export type WorkKind = 'illust' | 'novel';
export interface Ref { id: string; kind: WorkKind }
export interface Page { original: string; regular: string; width: number; height: number }
export interface Work extends Ref {
  title: string; userId: string; userName: string; thumb: string; pages: Page[];
  tags: string[]; bookmarkCount: number | null; bookmarked: boolean; following: boolean;
  restricted: number; ai: boolean; updated: string; description?: string; text?: string;
  avatar?: string; cover?: string; seriesId?: string; novelImages?: Record<string, string>;
  animation?: { src: string; frames: { file: string; delay: number }[] };
}
export interface HttpOptions { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; bytes?: boolean; signal?: AbortSignal }
export interface HttpResult { status: number; headers: Record<string, string>; body: string | Uint8Array }
export interface Store {
  get<T>(id: string): Promise<T | undefined>;
  set<T>(id: string, value: T): Promise<void>;
  remove(id: string): Promise<void>;
  list<T>(prefix: string): Promise<{ id: string; value: T }[]>;
}
export interface Runtime {
  mode: 'extension' | 'userscript'; store: Store;
  command?<T = void>(op: 'enqueue' | 'taskAction', args: unknown[]): Promise<T>;
  request(url: string, options?: HttpOptions): Promise<HttpResult>;
  save(data: Blob | string, filename: string, conflict?: 'uniquify' | 'overwrite' | 'prompt', receipt?: string, signal?: AbortSignal): Promise<void>;
  notify(): void;
  subscribe(callback: () => void): () => void;
}
export interface Filter {
  minBookmarks: number; hideBookmarked: boolean; hideFollowing: boolean; hideRead: boolean;
  hideAdult: boolean; hideAI: boolean; users: string[]; tags: string[];
}
export interface Settings {
  hover: boolean; hoverRatio: number; theme: 'auto' | 'light' | 'dark'; preload: number; hideAds: boolean;
  filename: string; folder: string; metadata: boolean; animationFormat: 'zip' | 'gif' | 'mp4' | 'webm';
  novelFormat: 'txt' | 'epub'; mangaZip: boolean; concurrency: number; filter: Filter; directory?: boolean;
}
export interface Reading { account: string; ref: Ref; title: string; thumb: string; page: number; position: number; at: number }
export type TaskState = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'paused' | 'uncertain';
export interface Task {
  id: string; ref: Ref; account: string; title: string; state: TaskState; created: number;
  settings: Settings; pages?: number[]; force?: boolean; asset?: 'avatar' | 'cover';
  completed: string[]; error?: string; progress: number; total: number; attempt?: string;
  uploaded?: string[]; savingFile?: string; uploadPending?: string[]; retries?: number;
}
export interface Schedule { id: string; source: string; everyMinutes: number; limit: number; next: number; enabled: boolean; account: string; settings: Settings }
export interface CloudConfig { url: string; username: string; password: string; upload: boolean }
export interface PixivClient {
  work(ref: Ref, signal?: AbortSignal): Promise<Work>;
  account(): Promise<string>;
  bookmark(ref: Ref, enabled: boolean, tags?: string[], privateBookmark?: boolean): Promise<void>;
  follow(userId: string, enabled: boolean): Promise<void>;
  list(source: string, page: number): Promise<{ refs: Ref[]; next: boolean }>;
}
export interface ExportFile { name: string; data: Blob | string }
export interface Media {
  export(work: Work, settings: Settings, options?: { pages?: number[]; asset?: 'avatar' | 'cover'; signal?: AbortSignal }): AsyncGenerator<ExportFile>;
  frames(work: Work, signal?: AbortSignal): Promise<{ images: ImageBitmap[]; delays: number[]; dispose(): void }>;
}
export interface Services {
  runtime: Runtime; client: PixivClient; media: Pick<Media, 'frames'>;
  settings: Settings;
  configure(settings: Settings): Promise<void>;
  enqueue(refs: Ref[], options?: { pages?: number[]; force?: boolean; asset?: 'avatar' | 'cover' }): Promise<void>;
  tasks(): Promise<Task[]>;
  taskAction(id: string, action: 'pause' | 'resume' | 'remove' | 'confirm'): Promise<void>;
  history(): Promise<Reading[]>;
  read(work: Work, page: number, position?: number): Promise<void>;
  backup(): Promise<Blob>;
  restore(text: string): Promise<void>;
  chooseDirectory(): Promise<void>;
  schedules(): Promise<Schedule[]>;
  schedule(source: string, everyMinutes: number, limit: number): Promise<void>;
  removeSchedule(id: string): Promise<void>;
  cloud(): Promise<CloudConfig | undefined>;
  setCloud(config: CloudConfig): Promise<void>;
  sync(choice?: 'local' | 'remote'): Promise<void>;
}
