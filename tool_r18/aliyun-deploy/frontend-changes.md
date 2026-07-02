# 前端修改指南

## 1. 更新环境变量

修改 `.env` 文件：

```env
# 阿里云配置
VITE_ALIYUN_API_URL=https://<api-gateway-url>/release
VITE_ALIYUN_OSS_BUCKET=next-chapter-storage
VITE_ALIYUN_OSS_REGION=cn-hangzhou

# （可选）保留 Supabase 配置用于平滑迁移
VITE_SUPABASE_PROJECT_ID=pzhfsunanifbvcbfvkhx
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_SUPABASE_URL=https://pzhfsunanifbvcbfvkhx.supabase.co
```

## 2. 创建阿里云客户端

在 `src/lib/` 目录下创建 `aliyun-client.ts`：

```typescript
/**
 * 阿里云 API 客户端
 */

const API_BASE_URL = import.meta.env.VITE_ALIYUN_API_URL || "";

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

/**
 * 项目类型
 */
export interface Project {
  id: string;
  title: string;
  script: string;
  scenes: any[];
  characters: any[];
  scene_settings: any[];
  art_style: string;
  current_step: number;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

/**
 * 获取项目列表
 */
export async function listProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE_URL}/api/projects`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * 获取单个项目
 */
export async function getProject(id: string): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * 创建项目
 */
export async function createProject(data: Partial<Project>): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * 更新项目
 */
export async function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * 删除项目
 */
export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

/**
 * 解析文档
 */
export async function parseDocument(file: File): Promise<{ text: string }> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/api/parse-document`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * API 代理
 */
export async function callAliyunProxy(
  targetUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
) {
  const headers: Record<string, string> = {
    "x-target-url": targetUrl,
    "x-target-headers": JSON.stringify(options.headers || {}),
  };

  const response = await fetch(`${API_BASE_URL}/api/proxy`, {
    method: options.method || "POST",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json();
}
```

## 3. 更新 Supabase 客户端

修改 `src/integrations/supabase/client.ts`，使其可以切换到阿里云：

```typescript
import { createClient } from "@supabase/supabase-js";
import * as aliyun from "@/lib/aliyun-client";

// 检测是否使用阿里云
const useAliyun = !!import.meta.env.VITE_ALIYUN_API_URL;

// Supabase 客户端（保留用于平滑迁移）
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL!;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
export const supabase = createClient(supabaseUrl, supabaseKey);

// 统一的项目 API
export const projectsApi = {
  async list() {
    if (useAliyun) {
      return aliyun.listProjects();
    }
    const { data, error } = await supabase.from("projects").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return data;
  },

  async get(id: string) {
    if (useAliyun) {
      return aliyun.getProject(id);
    }
    const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },

  async create(data: any) {
    if (useAliyun) {
      return aliyun.createProject(data);
    }
    const { data: result, error } = await supabase.from("projects").insert(data).select().single();
    if (error) throw error;
    return result;
  },

  async update(id: string, data: any) {
    if (useAliyun) {
      return aliyun.updateProject(id, data);
    }
    const { data: result, error } = await supabase.from("projects").update(data).eq("id", id).select().single();
    if (error) throw error;
    return result;
  },

  async delete(id: string) {
    if (useAliyun) {
      return aliyun.deleteProject(id);
    }
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) throw error;
  },
};

// 文档解析 API
export const documentApi = {
  async parse(file: File) {
    if (useAliyun) {
      return aliyun.parseDocument(file);
    }
    // 使用 Supabase Edge Function
    const { data, error } = await supabase.functions.invoke("parse-document", {
      method: "POST",
      body: { file },
    });
    if (error) throw error;
    return data;
  },
};
```

## 4. 更新 api-client.ts

修改 `src/lib/api-client.ts`，使用阿里云代理：

```typescript
import { getApiConfig } from "@/pages/Settings";
import { callAliyunProxy } from "@/lib/aliyun-client";

const DEFAULT_TIMEOUT = 300_000;
const useAliyun = !!import.meta.env.VITE_ALIYUN_API_URL;

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

  if (useAliyun) {
    // 使用阿里云代理
    return callAliyunProxy(`${endpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.zhanhuKey}`,
      },
      body,
    });
  }

  // 原有逻辑
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.zhanhuKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json();
}
```

## 5. 更新组件中的 API 调用

搜索项目中所有使用 Supabase 的地方，替换为统一的 API：

```typescript
// 之前
const { data } = await supabase.from("projects").select("*");

// 之后
const data = await projectsApi.list();
```

## 6. 测试

启动开发服务器测试：

```bash
npm run dev
```

确保所有功能正常工作后，可以部署到生产环境。
