export type ViewId =
  | "overview"
  | "tasks"
  | "workflowCatalog"
  | "viral"
  | "intel"
  | "knowledge"
  | "packages"
  | "workflows"
  | "entries"
  | "moduleSettings"
  | "logs";
export type LoadState = "idle" | "loading" | "ready" | "error";

export type StatusPayload = {
  ok?: boolean;
  time?: string;
  hermes?: Record<string, unknown>;
  model?: { configured?: boolean; providerId?: string; model?: string; baseUrlConfigured?: boolean; apiKeyConfigured?: boolean };
  notion?: { intelConfigured?: boolean; contentConfigured?: boolean } & Record<string, unknown>;
  runtime?: { cwd?: string; root?: string; wrongRunDir?: boolean; suggestedDir?: string; message?: string };
  packages?: { total?: number; unsynced?: number; latest?: Record<string, unknown> };
  workflows?: { running?: number; queued?: number; completed?: number; failed?: number };
  entryConfig?: { entries?: Array<{ id?: string; name?: string; enabled?: boolean; status?: string }> };
};

export type TaskStep = {
  id?: string;
  runId?: string;
  stepKey?: string;
  stepName?: string;
  key?: string;
  title?: string;
  name?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  inputSummary?: string;
  outputSummary?: string;
  message?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type ModelCall = {
  id?: string;
  runId?: string;
  stepId?: string;
  callType?: "text" | "image" | string;
  provider?: string;
  model?: string;
  purpose?: string;
  status?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
  createdAt?: string;
};

export type ModelUsageSummary = {
  calls?: number;
  textCalls?: number;
  imageCalls?: number;
  failedCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LocalTaskItem = {
  id: string;
  title?: string;
  type?: string;
  workflowId?: string;
  workflowName?: string;
  entryType?: string;
  status?: string;
  source?: string;
  input?: unknown;
  inputText?: string;
  output?: unknown;
  error?: string;
  packageId?: string;
  currentStep?: string;
  steps?: TaskStep[];
  modelCalls?: ModelCall[];
  modelUsage?: ModelUsageSummary;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type PackageImageSlot = {
  id: string;
  label?: string;
  type?: string;
  title?: string;
  purpose?: string;
  prompt?: string;
  dataUrl?: string;
  filePath?: string;
  missing?: boolean;
};

export type PackageDetailPayload = {
  title?: string;
  subtitle?: string;
  coverText?: string;
  coverStyle?: string;
  visualDirection?: string;
  hook?: string;
  postText?: string;
  hashtags?: string[];
  images?: PackageImageSlot[];
  markdown?: string;
  checklist?: string[];
  materials?: string[];
  qualityReview?: unknown;
  humanEditorReview?: unknown;
  files?: {
    packageDir?: string;
    packageJsonPath?: string;
    markdownPath?: string;
  };
  sections?: Array<{ title?: string; content?: string }>;
};

export type LocalPackageItem = {
  id: string;
  title?: string;
  status?: string;
  notionStatus?: string;
  notionUrl?: string;
  imageCount?: number;
  qualityScore?: number;
  aiFlavorScore?: number;
  humanTraceScore?: number;
  packageDir?: string;
  packageJsonPath?: string;
  markdownPath?: string;
  sourcePath?: string;
  generatedAt?: string;
  updatedAt?: string;
  detail?: PackageDetailPayload;
};

export type LocalIntelItem = {
  id: string;
  title?: string;
  summary?: string;
  category?: string;
  source?: string;
  sourceUrl?: string;
  url?: string;
  tags?: string[];
  usage?: string;
  fitFor?: string[];
  evaluationStatus?: string;
  valueScore?: number | null;
  recommendedAction?: string;
  evaluationReason?: string;
  processingStatus?: string;
  notionSyncStatus?: string;
  valueStatus?: string;
  actionSuggestion?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type KnowledgeItem = {
  id: string;
  title?: string;
  content?: string;
  category?: string;
  type?: string;
  platform?: string;
  scenario?: string;
  project?: string;
  status?: string;
  priority?: number;
  aiEnabled?: boolean;
  forbiddenNote?: string;
  tags?: string[] | string;
  updatedAt?: string;
};

export type LogLine = {
  id?: string;
  sourceId?: string;
  sourceName?: string;
  kind?: string;
  level?: string;
  time?: string;
  message?: string;
};

export type LogSource = {
  id?: string;
  name?: string;
  path?: string;
  kind?: string;
  exists?: boolean;
  size?: number;
  loadedLineCount?: number;
  updatedAt?: string;
};

export type LogsPayload = {
  ok?: boolean;
  updatedAt?: string;
  summary?: {
    totalLines?: number;
    activeSources?: number;
    errors?: number;
    warnings?: number;
    latestAt?: string;
    byLevel?: Record<string, number>;
  };
  sources?: LogSource[];
  lines?: LogLine[];
  logs?: string[];
  text?: string;
} | string[] | string;

export type ApiList<T> = { items?: T[]; total?: number } | T[];

export type SettingsPayload = {
  localApi?: { baseUrl?: string; port?: number; dataDir?: string };
  wechatAssistant?: { defaultCity?: string; weatherEnabled?: boolean };
  modelProvider?: { providerId?: string; baseUrl?: string; model?: string; apiKey?: { configured?: boolean; masked?: string } | string };
  assistantApi?: { enabled?: boolean; providerId?: string; baseUrl?: string; model?: string; apiKey?: { configured?: boolean; masked?: string } | string };
  notionIntel?: { enabled?: boolean; databaseId?: string; token?: { configured?: boolean; masked?: string } | string };
  notionContent?: { databaseId?: string; xiaohongshuEnableNotion?: boolean; token?: { configured?: boolean; masked?: string } | string };
  hermes?: { enabled?: boolean; mode?: string; provider?: string; command?: string; workerUrl?: string; wslDistro?: string; timeoutSeconds?: number; fallbackOnError?: boolean };
  imageGeneration?: { enabled?: boolean; baseUrl?: string; model?: string; size?: string; quality?: string; generateBodyImages?: boolean; maxGeneratedImages?: number; apiKey?: { configured?: boolean; masked?: string } | string };
  workflow?: { skills?: Record<string, { name?: string; enabled?: boolean; selectedFocuses?: string[]; focusOptions?: string[]; timeoutSeconds?: number; fallbackOnError?: boolean }> };
};
