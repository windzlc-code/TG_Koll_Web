# 阿里云完整迁移方案

## 📋 概述

将 Next Chapter 项目从 Supabase 完全迁移到阿里云的完整方案。

## 🚀 快速开始

### 1. 准备阿里云环境

- 注册阿里云账号
- 开通以下服务：
  - RDS PostgreSQL
  - 对象存储 OSS
  - 函数计算 FC
  - API 网关
  - 访问控制 RAM

### 2. 数据库迁移

参考 [database-migration.md](./database-migration.md)

```bash
# 创建数据库表
psql -h <rds-endpoint> -U postgres -d postgres -f database-migration.md
```

### 3. 部署函数计算

参考 [fc-deployment.md](./fc-deployment.md)

```bash
cd functions/api-proxy
npm install
zip -r api-proxy.zip .

# 使用阿里云 CLI 部署
aliyun fc CreateFunction ...
```

### 4. 配置 OSS

参考 [oss-config.md](./oss-config.md)

### 5. 配置 API 网关

参考 [api-gateway.md](./api-gateway.md)

### 6. 修改前端

参考 [frontend-changes.md](./frontend-changes.md)

## 📁 目录结构

```
aliyun-deploy/
├── README.md                    # 本文件
├── DEPLOYMENT_GUIDE.md          # 完整部署指南
├── database-migration.md        # 数据库迁移指南
├── fc-deployment.md             # 函数计算部署指南
├── oss-config.md                # OSS 配置指南
├── api-gateway.md               # API 网关配置指南
├── frontend-changes.md          # 前端修改指南
└── functions/                   # 函数计算代码
    ├── api-proxy/              # API 代理函数
    │   ├── index.js
    │   └── package.json
    ├── parse-document/         # 文档解析函数
    │   ├── index.js
    │   └── package.json
    └── projects-api/           # 项目 CRUD API
        ├── index.js
        └── package.json
```

## 🛠 技术栈

| 组件 | 技术选型 |
|------|----------|
| 数据库 | 阿里云 RDS PostgreSQL |
| 存储 | 阿里云 OSS |
| 后端 | 阿里云函数计算 FC (Node.js 18) |
| API 网关 | 阿里云 API 网关 |
| 前端 | React + Vite |

## 📊 架构对比

| 组件 | Supabase | 阿里云 |
|------|----------|--------|
| 数据库 | PostgreSQL | RDS PostgreSQL |
| 认证 | Supabase Auth | 自定义 JWT |
| 存储 | Supabase Storage | OSS |
| 函数 | Edge Functions | 函数计算 FC |
| API 网关 | 内置 | API 网关 |

## ⚠️ 注意事项

1. **数据备份**：迁移前务必备份 Supabase 数据
2. **平滑迁移**：建议先保持两套系统并行运行
3. **环境变量**：妥善保管阿里云 AccessKey，不要提交到代码仓库
4. **成本控制**：注意阿里云服务的费用，设置预算告警
5. **监控告警**：配置云监控，及时发现问题

## 📞 技术支持

如有问题，请联系：墨子（全栈工程师）🤖

## 📝 更新日志

- 2026-03-23: 初始版本，完整迁移方案
