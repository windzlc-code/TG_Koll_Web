/**
 * OpenAI/站狐/Gemini/Seedance/Vidu/Kling API 代理 - 阿里云函数计算版本
 * 作为中转站，根据 x-service header 选择不同的 API Key
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-target-url, x-target-headers, x-service",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

// 服务配置
const SERVICE_CONFIG = {
  gemini: {
    getAuth: (config) => `Bearer ${config.geminiApiKey}`,
  },
  jimeng: {
    getAuth: (config) => `Bearer ${config.jimengApiKey}`,
  },
  vidu: {
    getAuth: (config) => `Token ${config.viduApiKey}`,
  },
  kling: {
    getAuth: (config) => `Bearer ${config.klingApiKey}`,
  },
  zhanhu: {
    getAuth: (config) => `Bearer ${config.zhanhuApiKey}`,
  },
};

// 从环境变量读取配置
function getConfig() {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    jimengApiKey: process.env.JIMENG_API_KEY || "",
    viduApiKey: process.env.VIDU_API_KEY || "",
    klingApiKey: process.env.KLING_API_KEY || "",
    zhanhuApiKey: process.env.ZHANHU_API_KEY || "",
  };
}

module.exports.handler = async (req, res) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    res.set(corsHeaders);
    res.send("");
    return;
  }

  try {
    const config = getConfig();
    
    // 获取目标 URL
    let targetUrl = req.headers["x-target-url"];
    if (!targetUrl) {
      targetUrl = "https://api.zhanhu.ai/v1/chat/completions";
    }

    // 获取服务类型
    const service = req.headers["x-service"] || "zhanhu";
    const serviceConfig = SERVICE_CONFIG[service];
    
    if (!serviceConfig) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: `Unknown service: ${service}` }));
      return;
    }

    // 获取授权 header
    let authHeader = req.headers["authorization"];
    if (!authHeader) {
      authHeader = serviceConfig.getAuth(config);
    }

    if (!authHeader || authHeader === "Bearer " || authHeader === "Token ") {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: `API Key not configured for service: ${service}` }));
      return;
    }

    // 构建目标请求头
    const targetHeaders = {
      "Content-Type": "application/json",
      "Authorization": authHeader,
    };

    // 转发请求体
    let body = undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      body = typeof req.body ? JSON.stringify(req.body) : undefined;
    }

    console.log(`Proxying request to: ${targetUrl}, service: ${service}`);

    // 发起代理请求，设置 5 分钟超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    const response = await fetch(targetUrl, {
      method: req.method || "POST",
      headers: targetHeaders,
      body: body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 获取响应内容
    const responseBuffer = await response.arrayBuffer();

    console.log(`Response status: ${response.status}`);

    // 返回响应
    res.set({
      ...corsHeaders,
      "Content-Type": response.headers.get("Content-Type") || "application/json",
    });
    res.status(response.status).send(Buffer.from(responseBuffer));

  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown proxy error";
    console.error("Proxy error:", msg);
    
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.status(502).send(JSON.stringify({ error: msg }));
  }
};
