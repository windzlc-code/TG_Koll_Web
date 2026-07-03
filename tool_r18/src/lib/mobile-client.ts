export interface MobileConfig {
  ak?: string;
  sk?: string;
  accounts?: Array<{ name?: string; ak?: string; sk?: string }>;
}

function removed(): never {
  throw new Error("Use Web social automation with Camoufox browser profiles.");
}

export async function waitTask(_config: MobileConfig, _taskId: string, _timeoutMs = 30_000, _pollMs = 1_000): Promise<{ taskResult?: string }> {
  removed();
}

export async function inputText(_config: MobileConfig, _padCode: string, _text: string): Promise<void> {
  removed();
}

export async function screenshot(_config: MobileConfig, _padCode: string): Promise<string> {
  removed();
}

export async function listPads(_config: MobileConfig): Promise<any[]> {
  return [];
}

export async function getPadInfo(_config: MobileConfig, _padCode: string): Promise<any | null> {
  return null;
}
