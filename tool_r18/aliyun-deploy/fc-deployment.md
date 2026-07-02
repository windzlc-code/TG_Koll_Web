# 函数计算部署指南

## 函数列表

| 函数名 | 功能 | 运行时 |
|--------|------|--------|
| api-proxy | API 代理，解决 CORS 问题 | Node.js 18 |
| parse-document | 文档解析（TXT/PDF/DOCX） | Node.js 18 |
| projects-api | 项目 CRUD API | Node.js 18 |

## 部署步骤

### 1. 安装阿里云 CLI

```bash
# 安装阿里云 CLI
pip install aliyun-cli

# 配置
aliyun configure
```

### 2. 创建服务

```bash
aliyun fc CreateService \
  --ServiceName next-chapter-service \
  --Description "Next Chapter API Service" \
  --Role acs:ram::<account-id>:role/aliyunfcdefaultrole
```

### 3. 部署函数

#### api-proxy
```bash
cd functions/api-proxy
npm install
zip -r api-proxy.zip .

aliyun fc CreateFunction \
  --ServiceName next-chapter-service \
  --FunctionName api-proxy \
  --Runtime nodejs18 \
  --Handler index.handler \
  --CodeZipFile api-proxy.zip \
  --MemorySize 512 \
  --Timeout 300
```

#### parse-document
```bash
cd functions/parse-document
npm install
zip -r parse-document.zip .

aliyun fc CreateFunction \
  --ServiceName next-chapter-service \
  --FunctionName parse-document \
  --Runtime nodejs18 \
  --Handler index.handler \
  --CodeZipFile parse-document.zip \
  --MemorySize 1024 \
  --Timeout 600
```

#### projects-api
```bash
cd functions/projects-api
npm install
zip -r projects-api.zip .

aliyun fc CreateFunction \
  --ServiceName next-chapter-service \
  --FunctionName projects-api \
  --Runtime nodejs18 \
  --Handler index.handler \
  --CodeZipFile projects-api.zip \
  --MemorySize 512 \
  --Timeout 30
```

### 4. 配置环境变量

在函数计算控制台配置环境变量：
- `DATABASE_URL`: PostgreSQL 连接字符串
- `OSS_BUCKET`: OSS Bucket 名称
- `OSS_REGION`: OSS 区域
- `LOVABLE_API_KEY`: Lovable API Key
