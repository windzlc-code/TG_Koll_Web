export interface MobileConfig {
  ak?: string;
  sk?: string;
  accounts?: Array<{ name?: string; ak?: string; sk?: string }>;
}

export async function execAdb(_config: MobileConfig, _padCode: string, _command: string): Promise<string> {
  throw new Error("Legacy mobile automation has been removed from this project");
}

export async function waitTask(_config: MobileConfig, _taskId: string, _timeoutMs = 30_000, _pollMs = 1_000): Promise<{ taskResult?: string }> {
  throw new Error("Legacy mobile automation has been removed from this project");
}

export async function inputText(_config: MobileConfig, _padCode: string, _text: string): Promise<void> {
  throw new Error("Legacy mobile automation has been removed from this project");
}

export async function screenshot(_config: MobileConfig, _padCode: string): Promise<string> {
  throw new Error("Legacy mobile automation has been removed from this project");
}

export async function listPads(_config: MobileConfig): Promise<any[]> {
  return [];
}

export async function getPadInfo(_config: MobileConfig, _padCode: string): Promise<any | null> {
  return null;
}
