# 简化版部署：API 代理到阿里云 FC

## 概述
只部署一个 API 代理函数到阿里云函数计算，作为中转站转发请求给 OpenAI/站狐 API。

## 架构
```
用户前端 → 阿里云 FC (API代理) → OpenAI/站狐 API
```

## 快速开始

### 1. 配置阿里云 CLI
参考 `01-setup-cli.md`

### 2. 部署函数
```powershell
.\02-deploy-proxy.ps1
```

### 3. 修改前端
更新 `api-client.ts`，使用 FC 代理
