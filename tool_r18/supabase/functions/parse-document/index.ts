import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { ZipReader, BlobReader, TextWriter } from "https://deno.land/x/zipjs@v2.7.32/index.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(
        JSON.stringify({ error: "未上传文件" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fileName = file.name.toLowerCase();
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return new Response(
        JSON.stringify({ error: "文件大小不能超过 10MB" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let text = "";

    if (fileName.endsWith(".txt")) {
      // Plain text
      text = await file.text();
    } else if (fileName.endsWith(".pdf")) {
      // Use Lovable AI to extract text from PDF
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY 未配置");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const base64 = btoa(String.fromCharCode(...bytes));

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "请完整提取以下文档中的所有文字内容，保持原始格式和换行。只输出文档内容，不要添加任何额外说明。",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:application/pdf;base64,${base64}`,
                  },
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("AI parse error:", response.status, errText);
        throw new Error("PDF 解析失败");
      }

      const data = await response.json();
      text = data.choices?.[0]?.message?.content || "";
    } else if (fileName.endsWith(".docx")) {
      // DOCX is a ZIP containing XML. Extract text from word/document.xml
      try {
        const blob = new Blob([await file.arrayBuffer()]);
        const zipReader = new ZipReader(new BlobReader(blob));
        const entries = await zipReader.getEntries();
        const docEntry = entries.find((e: any) => e.filename === "word/document.xml");
        if (!docEntry) throw new Error("无法读取 DOCX 内容");
        const xmlText = await docEntry.getData!(new TextWriter());
        await zipReader.close();
        // Extract text from XML tags <w:t>...</w:t>
        const matches = xmlText.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
        const parts: string[] = [];
        const lastWasParagraph = false;
        // Also detect paragraph boundaries <w:p>
        const paragraphs = xmlText.split(/<\/w:p>/);
        for (const para of paragraphs) {
          const tMatches = para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
          const line = Array.from(tMatches).map((m) => m[1]).join("");
          if (line) parts.push(line);
        }
        text = parts.join("\n");
      } catch (e: any) {
        console.error("DOCX parse error:", e);
        throw new Error("DOCX 解析失败: " + (e.message || "未知错误"));
      }
    } else if (fileName.endsWith(".doc")) {
      // .doc (legacy binary format) - extract readable text bytes
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        // Simple extraction: find text runs in binary .doc
        // This is a best-effort approach for legacy .doc files
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const rawText = decoder.decode(bytes);
        // Filter to printable characters and common CJK ranges
        text = rawText.replace(/[^\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\n\r\t]/g, "")
          .replace(/\r\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (!text) throw new Error("无法从 .doc 文件中提取文字");
      } catch (e: any) {
        console.error("DOC parse error:", e);
        throw new Error("建议将 .doc 文件另存为 .docx 或 .txt 格式后重新上传");
      }
    } else {
      return new Response(
        JSON.stringify({ error: "不支持的文件格式，请上传 TXT、PDF 或 Word 文档" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!text.trim()) {
      return new Response(
        JSON.stringify({ error: "文档内容为空" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ text }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("parse-document error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
