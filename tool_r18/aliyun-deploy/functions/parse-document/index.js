/**
 * Parse Document - 阿里云函数计算版本
 * 支持 TXT、PDF、DOCX 文档解析
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
    // 处理文件上传
    if (!req.files || !req.files.file) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: "未上传文件" }));
      return;
    }

    const file = req.files.file;
    const fileName = file.name.toLowerCase();
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (file.size > maxSize) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: "文件大小不能超过 10MB" }));
      return;
    }

    let text = "";

    if (fileName.endsWith(".txt")) {
      // Plain text
      text = file.data.toString('utf8');
    } else if (fileName.endsWith(".pdf")) {
      // PDF 解析 - 使用 pdf-parse 或调用 AI API
      text = await parsePdf(file);
    } else if (fileName.endsWith(".docx")) {
      // DOCX 解析
      text = await parseDocx(file);
    } else if (fileName.endsWith(".doc")) {
      // .doc (legacy binary format)
      text = await parseDoc(file);
    } else {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: "不支持的文件格式，请上传 TXT、PDF 或 Word 文档" }));
      return;
    }

    if (!text.trim()) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(400).send(JSON.stringify({ error: "文档内容为空" }));
      return;
    }

    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.send(JSON.stringify({ text }));

  } catch (e) {
    console.error("parse-document error:", e);
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.status(500).send(JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }));
  }
};

/**
 * PDF 解析
 */
async function parsePdf(file) {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  if (!LOVABLE_API_KEY) {
    throw new Error("LOVABLE_API_KEY 未配置");
  }

  const base64 = file.data.toString('base64');

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
  return data.choices?.[0]?.message?.content || "";
}

/**
 * DOCX 解析
 */
async function parseDocx(file) {
  try {
    // 使用 adm-zip 解压 DOCX（DOCX 实际上是 ZIP 文件）
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(file.data);
    const zipEntries = zip.getEntries();
    
    // 查找 document.xml
    const docEntry = zipEntries.find(entry => entry.entryName === "word/document.xml");
    if (!docEntry) {
      throw new Error("无法读取 DOCX 内容");
    }

    const xmlText = docEntry.getData().toString('utf8');
    
    // 从 XML 标签中提取文本 <w:t>...</w:t>
    // 同时检测段落边界 <w:p>
    const paragraphs = xmlText.split(/<\/w:p>/);
    const parts = [];
    
    for (const para of paragraphs) {
      const tMatches = para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
      const line = Array.from(tMatches).map((m) => m[1]).join("");
      if (line) parts.push(line);
    }
    
    return parts.join("\n");
  } catch (e) {
    console.error("DOCX parse error:", e);
    throw new Error("DOCX 解析失败: " + (e.message || "未知错误"));
  }
}

/**
 * DOC 解析（遗留格式）
 */
async function parseDoc(file) {
  try {
    const buffer = file.data;
    // 简单提取：从二进制 .doc 中找文本
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const rawText = decoder.decode(buffer);
    // 过滤可打印字符和常见中文范围
    const text = rawText.replace(/[^\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\n\r\t]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    
    if (!text) {
      throw new Error("无法从 .doc 文件中提取文字");
    }
    
    return text;
  } catch (e) {
    console.error("DOC parse error:", e);
    throw new Error("建议将 .doc 文件另存为 .docx 或 .txt 格式后重新上传");
  }
}
