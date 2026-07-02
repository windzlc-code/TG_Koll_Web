/**
 * Projects API - 阿里云函数计算版本
 * 项目 CRUD API
 */

const { Pool } = require('pg');

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

// 数据库连接池
let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

module.exports.handler = async (req, res) => {
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    res.set(corsHeaders);
    res.send("");
    return;
  }

  try {
    const path = req.path || req.url;
    const method = req.method;

    // 路由处理
    if (method === "GET" && (path === "/" || path === "")) {
      await listProjects(req, res);
    } else if (method === "GET" && path.match(/^\/[0-9a-f-]+$/i)) {
      await getProject(req, res);
    } else if (method === "POST" && (path === "/" || path === "")) {
      await createProject(req, res);
    } else if (method === "PUT" && path.match(/^\/[0-9a-f-]+$/i)) {
      await updateProject(req, res);
    } else if (method === "DELETE" && path.match(/^\/[0-9a-f-]+$/i)) {
      await deleteProject(req, res);
    } else {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(404).send(JSON.stringify({ error: "Not found" }));
    }
  } catch (e) {
    console.error("API error:", e);
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.status(500).send(JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }));
  }
};

/**
 * 获取项目列表
 */
async function listProjects(req, res) {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT * FROM public.projects ORDER BY updated_at DESC LIMIT 100'
    );
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.send(JSON.stringify(result.rows));
  } finally {
    client.release();
  }
}

/**
 * 获取单个项目
 */
async function getProject(req, res) {
  const id = req.path.split('/').pop();
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT * FROM public.projects WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(404).send(JSON.stringify({ error: "Project not found" }));
      return;
    }
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.send(JSON.stringify(result.rows[0]));
  } finally {
    client.release();
  }
}

/**
 * 创建项目
 */
async function createProject(req, res) {
  const data = req.body || {};
  const client = await getPool().connect();
  try {
    const result = await client.query(
      `INSERT INTO public.projects 
       (title, script, scenes, characters, scene_settings, art_style, current_step, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.title || '未命名项目',
        data.script || '',
        JSON.stringify(data.scenes || []),
        JSON.stringify(data.characters || []),
        JSON.stringify(data.scene_settings || []),
        data.art_style || 'realistic',
        data.current_step || 1,
        data.system_prompt || ''
      ]
    );
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.status(201).send(JSON.stringify(result.rows[0]));
  } finally {
    client.release();
  }
}

/**
 * 更新项目
 */
async function updateProject(req, res) {
  const id = req.path.split('/').pop();
  const data = req.body || {};
  
  const client = await getPool().connect();
  try {
    // 先检查项目是否存在
    const checkResult = await client.query(
      'SELECT * FROM public.projects WHERE id = $1',
      [id]
    );
    if (checkResult.rows.length === 0) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(404).send(JSON.stringify({ error: "Project not found" }));
      return;
    }

    const result = await client.query(
      `UPDATE public.projects 
       SET title = COALESCE($1, title),
           script = COALESCE($2, script),
           scenes = COALESCE($3, scenes),
           characters = COALESCE($4, characters),
           scene_settings = COALESCE($5, scene_settings),
           art_style = COALESCE($6, art_style),
           current_step = COALESCE($7, current_step),
           system_prompt = COALESCE($8, system_prompt)
       WHERE id = $9
       RETURNING *`,
      [
        data.title,
        data.script,
        data.scenes ? JSON.stringify(data.scenes) : null,
        data.characters ? JSON.stringify(data.characters) : null,
        data.scene_settings ? JSON.stringify(data.scene_settings) : null,
        data.art_style,
        data.current_step,
        data.system_prompt,
        id
      ]
    );
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.send(JSON.stringify(result.rows[0]));
  } finally {
    client.release();
  }
}

/**
 * 删除项目
 */
async function deleteProject(req, res) {
  const id = req.path.split('/').pop();
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'DELETE FROM public.projects WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      res.set({ ...corsHeaders, "Content-Type": "application/json" });
      res.status(404).send(JSON.stringify({ error: "Project not found" }));
      return;
    }
    res.set({ ...corsHeaders, "Content-Type": "application/json" });
    res.send(JSON.stringify({ success: true }));
  } finally {
    client.release();
  }
}
