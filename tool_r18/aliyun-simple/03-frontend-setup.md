# 前端配置指南

## 第一步：获取函数调用 URL

1. 访问 https://fcnext.console.aliyun.com/
2. 找到 `api-proxy-service` 服务
3. 点击 `api-proxy` 函数
4. 在"配置" → "触发器管理"中创建 HTTP 触发器
5. 获取调用 URL，类似：`https://xxxxx.cn-hangzhou.fc.aliyuncs.com/2016-08-15/proxy/api-proxy-service/api-proxy/`

## 第二步：配置环境变量

在项目根目录创建或更新 `.env` 文件：

```env
# 阿里云 FC 代理 URL
VITE_ALIYUN_PROXY_URL=https://xxxxx.cn-hangzhou.fc.aliyuncs.com/2016-08-15/proxy/api-proxy-service/api-proxy/

# 可选：保留原有 Supabase 配置
VITE_SUPABASE_PROJECT_ID=pzhfsunanifbvcbfvkhx
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_SUPABASE_URL=https://pzhfsunanifbvcbfvkhx.supabase.co
```

## 第三步：修改 api-client.ts

修改 `src/lib/api-client.ts`：

```typescript
/**
 * API Client - 使用阿里云 FC 代理
 */

import { getApiConfig } from "@/pages/Settings";

const DEFAULT_TIMEOUT = 300_000;
const PROXY_URL = import.meta.env.VITE_ALIYUN_PROXY_URL || "";
const useProxy = !!PROXY_URL;

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

/**
 * 调用 AI 模型 API
 */
export async function callAiApi<T = any>(
  body: Record<string, unknown>,
  options: {
    endpoint?: string;
    path?: string;
    timeout?: number;
  } = {}
): Promise<T> {
  const config = getApiConfig();
  const endpoint = options.endpoint || "https://api.zhanhu.ai/v1";
  const path = options.path || "/chat/completions";

  if (!config.zhanhuKey) {
    throw new Error("请先在设置中配置站狐 API Key");
  }

  if (useProxy) {
    // 使用阿里云 FC 代理
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);

    try {
      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.zhanhuKey}`,
          "x-target-url": `${endpoint}${path}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `HTTP ${response.status}`);
      }

      const data = await response.json();
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // 原有逻辑（直连）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);

  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.zhanhuKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用视频生成 API
 */
export async function callVideoApi<T = any>(
  body: Record<string, unknown>,
  options: {
    timeout?: number;
  } = {}
): Promise<T> {
  const config = getApiConfig();
  const endpoint = "https://api.zhanhu.ai/v1";

  if (!config.jimeng) {
    throw new Error("请先在设置中配置 Jimeng API Key");
  }

  if (useProxy) {
    // 使用阿里云 FC 代理
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.jimeng}`,
        "x-target-url": `${endpoint}/video/generate`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
    }

    return response.json() as T;
  }

  // 原有逻辑
  const response = await fetch(`${endpoint}/video/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.jimeng}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as T;
}
```

## 第四步：测试

1. 重启开发服务器
2. 测试 AI 功能是否正常工作
3. 查看网络请求，确认通过 FC 代理

---

完成！🎉
