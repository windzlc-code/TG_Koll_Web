/**
 * 轻量级 API 代理 — 仅做请求转发，解决 HTTPS→HTTP 和 CORS 问题
 * 所有提示词逻辑均在前端完成，此函数不含任何业务逻辑
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-target-url, x-target-headers, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const targetUrl = req.headers.get("x-target-url");
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Missing x-target-url header" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse target headers from JSON-encoded header
    let targetHeaders: Record<string, string> = {};
    const targetHeadersRaw = req.headers.get("x-target-headers");
    if (targetHeadersRaw) {
      try {
        targetHeaders = JSON.parse(targetHeadersRaw);
      } catch {
        // ignore parse errors
      }
    }

    // Ensure content-type is forwarded
    const contentType = req.headers.get("content-type");
    if (contentType && !targetHeaders["Content-Type"] && !targetHeaders["content-type"]) {
      targetHeaders["Content-Type"] = contentType;
    }

    // Forward request body
    const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;

    // Make the proxied request with a generous timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: targetHeaders,
      body: body ? new Uint8Array(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Stream the response back
    return new Response(response.body, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown proxy error";
    console.error("Proxy error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
