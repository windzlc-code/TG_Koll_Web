/**
 * API Proxy - 阿里云函数计算版本
 * 轻量级 API 代理 — 仅做请求转发，解决 HTTPS→HTTP 和 CORS 问题
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-target-url, x-target-headers",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

module.exports.handler = async (req, res) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    res.set(corsHeaders);
    res.send("");
    return;
  }

  try {
    const targetUrl = req.headers["x-target-url"];
    if (!targetUrl) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: "Missing x-target-url header" }));
      return;
    }

    // 解析目标请求头
    let targetHeaders = {};
    const targetHeadersRaw = req.headers["x-target-headers"];
    if (targetHeadersRaw) {
      try {
        targetHeaders = JSON.parse(targetHeadersRaw);
      } catch {
        // 忽略解析错误
      }
    }

    // 转发 content-type
    const contentType = req.headers["content-type"];
    if (contentType && !targetHeaders["Content-Type"] && !targetHeaders["content-type"]) {
      targetHeaders["Content-Type"] = contentType;
    }

    // 转发请求体
    let body = undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    // 发起代理请求，设置 5 分钟超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: targetHeaders,
      body: body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 获取响应内容
    const responseBuffer = await response.arrayBuffer();

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
