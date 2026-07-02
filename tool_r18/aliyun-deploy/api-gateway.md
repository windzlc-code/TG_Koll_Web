# API 网关配置指南

## API 结构

| 路径 | 方法 | 后端服务 | 描述 |
|------|------|----------|------|
| /api/proxy | ANY | api-proxy | API 代理 |
| /api/parse-document | POST | parse-document | 文档解析 |
| /api/projects | GET | projects-api | 获取项目列表 |
| /api/projects | POST | projects-api | 创建项目 |
| /api/projects/{id} | GET | projects-api | 获取单个项目 |
| /api/projects/{id} | PUT | projects-api | 更新项目 |
| /api/projects/{id} | DELETE | projects-api | 删除项目 |

## 配置步骤

### 1. 创建 API

在 API 网关控制台创建 API：

- API 名称：next-chapter-api
- 协议：HTTP & HTTPS
- 认证方式：无（或 JWT）

### 2. 创建资源和方法

#### /api/proxy
- 资源路径：/api/proxy
- 方法：ANY
- 后端类型：函数计算 FC
- 服务：next-chapter-service
- 函数：api-proxy

#### /api/parse-document
- 资源路径：/api/parse-document
- 方法：POST
- 后端类型：函数计算 FC
- 服务：next-chapter-service
- 函数：parse-document
- 请求格式：multipart/form-data

#### /api/projects
- 资源路径：/api/projects
- 方法：GET, POST
- 后端类型：函数计算 FC
- 服务：next-chapter-service
- 函数：projects-api

#### /api/projects/{id}
- 资源路径：/api/projects/{id}
- 方法：GET, PUT, DELETE
- 后端类型：函数计算 FC
- 服务：next-chapter-service
- 函数：projects-api
- 路径参数：id

### 3. 配置 CORS

在 API 网关控制台配置 CORS：

- 允许来源：*
- 允许方法：GET, POST, PUT, DELETE, OPTIONS
- 允许头部：*
- 暴露头部：*
- 预检请求缓存时间：300 秒

### 4. 发布 API

发布 API 到线上环境：

- 环境名称：release
- 域名：使用自动分配的域名或绑定自定义域名

## 最终 API 端点

```
https://<api-id>.execute-api.<region>.aliyuncs.com/release
```

## 测试 API

使用 curl 测试 API：

```bash
# 获取项目列表
curl https://<api-endpoint>/api/projects

# 创建项目
curl -X POST https://<api-endpoint>/api/projects \
  -H "Content-Type: application/json" \
  -d '{"title": "测试项目"}'

# 解析文档
curl -X POST https://<api-endpoint>/api/parse-document \
  -F "file=@test.txt"
```
