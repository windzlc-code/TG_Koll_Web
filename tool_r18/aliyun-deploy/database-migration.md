# 数据库迁移指南

## 数据库结构

### 当前 Supabase 数据库表

#### projects 表
```sql
CREATE TABLE public.projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '未命名项目',
  script TEXT NOT NULL DEFAULT '',
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb,
  characters JSONB NOT NULL DEFAULT '[]'::jsonb,
  scene_settings JSONB NOT NULL DEFAULT '[]'::jsonb,
  art_style TEXT NOT NULL DEFAULT 'realistic',
  current_step INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

### 完整数据库初始化脚本

```sql
-- ============================================
-- Next Chapter 数据库初始化脚本
-- 适用于阿里云 RDS PostgreSQL
-- ============================================

-- 1. 创建扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. 创建 projects 表
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '未命名项目',
  script TEXT NOT NULL DEFAULT '',
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb,
  characters JSONB NOT NULL DEFAULT '[]'::jsonb,
  scene_settings JSONB NOT NULL DEFAULT '[]'::jsonb,
  art_style TEXT NOT NULL DEFAULT 'realistic',
  current_step INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON public.projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON public.projects(updated_at DESC);

-- 4. 创建自动更新 updated_at 的函数
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- 5. 创建触发器
DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 6. 创建用户表（如果需要认证）
CREATE TABLE IF NOT EXISTS public.users (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 7. 创建用户表的触发器
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- 数据迁移脚本
-- ============================================

-- 从 Supabase 导出数据
-- pg_dump -h pzhfsunanifbvcbfvkhx.supabase.co -p 5432 -U postgres -d postgres -n public --data-only > data.sql

-- 导入到阿里云 RDS
-- psql -h <rds-endpoint> -p 5432 -U postgres -d postgres -f data.sql
