# 阿里云完整迁移指南

## 概述

将 Next Chapter 项目从 Supabase 完全迁移到阿里云。

## 架构对比

| 组件 | Supabase | 阿里云 |
|------|----------|--------|
| 数据库 | PostgreSQL | RDS PostgreSQL |
| 认证 | Supabase Auth | 自定义 JWT |
| 存储 | Supabase Storage | OSS |
| 函数 | Edge Functions | 函数计算 FC |
| API 网关 | 内置 | API 网关 |

## 迁移步骤

### 1. 准备阿里云环境

#### 1.1 开通服务
- RDS PostgreSQL
- 对象存储 OSS
- 函数计算 FC
- API 网关
- 访问控制 RAM

#### 1.2 创建 AccessKey
在阿里云控制台创建 RAM 用户并生成 AccessKey。

### 2. 数据库迁移

#### 2.1 创建 RDS 实例
```bash
# 使用阿里云 CLI 创建 RDS 实例
aliyun rds CreateDBInstance \
  --Engine PostgreSQL \
  --EngineVersion 15.0 \
  --DBInstanceClass pg.n2.medium.2c \
  --DBInstanceStorage 20 \
  --DBInstanceIdentifier next-chapter-db
```

#### 2.2 导出 Supabase 数据
```bash
# 从 Supabase 导出数据
pg_dump -h pzhfsunanifbvcbfvkhx.supabase.co \
  -p 5432 \
  -U postgres \
  -d postgres \
  -n public \
  --schema-only > schema.sql

pg_dump -h pzhfsunanifbvcbfvkhx.supabase.co \
  -p 5432 \
  -U postgres \
  -d postgres \
  -n public \
  --data-only > data.sql
```

#### 2.3 导入到 RDS
```bash
# 导入到阿里云 RDS
psql -h <rds-endpoint> \
  -p 5432 \
  -U postgres \
  -d postgres \
  -f schema.sql

psql -h <rds-endpoint> \
  -p 5432 \
  -U postgres \
  -d postgres \
  -f data.sql
```

### 3. OSS 存储配置

#### 3.1 创建 Bucket
```bash
aliyun oss mb oss://next-chapter-storage \
  --region cn-hangzhou \
  --acl private
```

#### 3.2 配置 CORS
在 OSS 控制台配置 CORS 规则。

### 4. 函数计算部署

#### 4.1 创建服务
```bash
aliyun fc CreateService \
  --ServiceName next-chapter-service \
  --Description "Next Chapter API Service"
```

#### 4.2 部署函数
```bash
# 部署 api-proxy
aliyun fc CreateFunction \
  --ServiceName next-chapter-service \
  --FunctionName api-proxy \
  --Runtime nodejs18 \
  --Handler index.handler \
  --CodeDir ./functions/api-proxy

# 部署 parse-document
aliyun fc CreateFunction \
  --ServiceName next-chapter-service \
  --FunctionName parse-document \
  --Runtime nodejs18 \
  --Handler index.handler \
  --CodeDir ./functions/parse-document
```

### 5. API 网关配置

#### 5.1 创建 API
在 API 网关控制台创建 API，将请求转发到函数计算。

### 6. 前端配置修改

更新 `.env` 文件中的配置：
```env
VITE_ALIYUN_API_URL=https://<api-gateway-url>
VITE_ALIYUN_OSS_BUCKET=next-chapter-storage
VITE_ALIYUN_OSS_REGION=cn-hangzhou
```

## 详细文档

- [数据库迁移](./database-migration.md)
- [函数计算部署](./fc-deployment.md)
- [OSS 配置](./oss-config.md)
- [API 网关配置](./api-gateway.md)
- [前端修改](./frontend-changes.md)
