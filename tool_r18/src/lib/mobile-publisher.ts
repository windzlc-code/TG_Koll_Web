import type { MobileConfig } from "./mobile-client";

export interface PublishProgress {
  step: string;
  done?: boolean;
  error?: string;
  warning?: string;
  screenshotUrl?: string;
  samplePath?: string;
  manualIntervention?: boolean;
  [key: string]: any;
}

export interface PublishResult {
  ok?: boolean;
  state?: "verified" | "warning" | string;
  detail?: string;
  error?: string;
  screenshotUrl?: string;
  publishedUrl?: string;
  [key: string]: any;
}
export type WarmupConfig = Record<string, unknown>;
export type WarmupCandidate = Record<string, unknown>;
export type WarmupCommentPersona = Record<string, unknown>;
export type ThreadsAutoReplyProgress = PublishProgress & Record<string, any>;
export type ThreadsOwnPostReplyProgress = PublishProgress & Record<string, any>;
export type ThreadsOwnPostReplyTarget = Record<string, unknown>;

function removed(): never {
  throw new Error("Legacy mobile automation has been removed from this project");
}

export async function publishPost(_config: MobileConfig, _task: any, _onProgress?: (progress: PublishProgress) => void, _options?: any): Promise<PublishResult> {
  removed();
}

export async function queryThreadsAccount(..._args: any[]): Promise<any> { removed(); }
export async function loginThreadsAccount(..._args: any[]): Promise<any> { removed(); }
export async function clearThreadsAccountSession(..._args: any[]): Promise<any> { removed(); }
export async function queryTelegramAccountSession(..._args: any[]): Promise<any> { removed(); }
export async function clearTelegramAccountSession(..._args: any[]): Promise<any> { removed(); }
export async function startTelegramAccountLoginSession(..._args: any[]): Promise<any> { removed(); }
export async function updateThreadsProfileLink(..._args: any[]): Promise<any> { removed(); }
export async function updateThreadsProfileBio(..._args: any[]): Promise<any> { removed(); }
export async function updateThreadsProfileName(..._args: any[]): Promise<any> { removed(); }
export async function updateThreadsProfileAvatar(..._args: any[]): Promise<any> { removed(); }
export async function warmupThreadsAccount(..._args: any[]): Promise<any> { removed(); }
export async function executeWarmupCandidate(..._args: any[]): Promise<any> { removed(); }
export async function autoReplyThreadsAccount(..._args: any[]): Promise<any> { removed(); }
export async function replyOwnPublishedThreadsPosts(..._args: any[]): Promise<any> { removed(); }

export function buildWarmupInterestKeywords(value?: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function extractThreadsPublishedPostUrlFromReaderMarkdown(markdown?: string): string {
  const match = String(markdown || "").match(/https?:\/\/\S+/);
  return match ? match[0] : "";
}
