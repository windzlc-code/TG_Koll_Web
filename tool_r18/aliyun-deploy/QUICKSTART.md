# 🚀 快速开始指南

## 总览

按照以下步骤，10分钟内完成阿里云环境配置！

---

## 第一步：准备工作（5分钟）

### 1.1 注册/登录阿里云
- 访问 https://www.aliyun.com/
- 注册账号并实名认证（如果还没有）

### 1.2 创建 RAM 用户并获取 AccessKey
1. 访问 https://ram.console.aliyun.com/
2. 点击"创建用户"
   - 用户名：`next-chapter-deploy`
   - 勾选"OpenAPI 调用访问"
3. **重要！** 保存 AccessKey ID 和 AccessKey Secret（只显示一次）
4. 给用户添加权限：
   - `AliyunRDSFullAccess`
   - `AliyunOSSFullAccess`
   - `AliyunFCFullAccess`
   - `AliyunAPIGatewayFullAccess`

### 1.3 安装阿里云 CLI
```powershell
winget install Alibaba.AliyunCLI
```

### 1.4 配置 CLI
```powershell
aliyun configure set --profile default `
  --mode AK `
  --region cn-hangzhou `
  --access-key-id <你的AccessKeyId> `
  --access-key-secret <你的AccessKeySecret>
```

验证配置：
```powershell
aliyun sts GetCallerIdentity
```

---

## 第二步：创建云服务（3分钟）

### 2.1 运行自动化脚本
```powershell
cd aliyun-deploy
.\02-create-services.ps1
```

### 2.2 手动创建 RDS（重要！）
脚本会提示你手动创建 RDS，因为涉及计费：
1. 访问 https://rdsnext.console.aliyun.com/
2. 创建 PostgreSQL 15.0 实例
3. 规格：pg.n2.medium.2c（2核4GB）
4. 存储：20GB
5. 实例名：`next-chapter-db`
6. **重要**：创建后设置白名单，允许公网访问

---

## 第三步：部署函数（2分钟）

### 3.1 运行部署脚本
```powershell
.\03-deploy-functions.ps1
```

### 3.2 配置环境变量
在函数计算控制台，给每个函数配置环境变量：
- `DATABASE_URL`: postgresql://user:password@rds-endpoint:5432/postgres
- `OSS_BUCKET`: next-chapter-storage-cn-hangzhou
- `OSS_REGION`: cn-hangzhou
- `LOVABLE_API_KEY`: （你的 Lovable API Key）

---

## 第四步：配置 API 网关

参考 [api-gateway.md](./api-gateway.md) 手动配置 API 网关。

---

## 第五步：数据库初始化

### 5.1 连接 RDS
```powershell
psql -h <rds-endpoint> -p 5432 -U postgres -d postgres
```

### 5.2 执行初始化脚本
复制 [database-migration.md](./database-migration.md) 中的 SQL 并执行。

---

## 第六步：修改前端

参考 [frontend-changes.md](./frontend-changes.md) 修改前端代码。

---

## ✅ 检查清单

- [ ] 阿里云账号已注册并实名认证
- [ ] RAM 用户已创建，AccessKey 已保存
- [ ] 阿里云 CLI 已安装并配置
- [ ] OSS Bucket 已创建
- [ ] RDS PostgreSQL 实例已创建
- [ ] 函数计算服务已创建
- [ ] 三个函数已部署
- [ ] 函数环境变量已配置
- [ ] API 网关已配置
- [ ] 数据库表已创建
- [ ] 前端代码已修改
- [ ] 测试通过

---

## 🆘 需要帮助？

1. 查看详细文档：
   - [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - 完整部署指南
   - [database-migration.md](./database-migration.md) - 数据库迁移
   - [fc-deployment.md](./fc-deployment.md) - 函数计算部署
   - [api-gateway.md](./api-gateway.md) - API 网关配置
   - [frontend-changes.md](./frontend-changes.md) - 前端修改

2. 联系技术支持：墨子（全栈工程师）🤖

---

## 💡 小贴士

- **费用**：阿里云服务按量付费，测试完可以释放避免浪费
- **安全**：AccessKey 不要提交到代码仓库
- **备份**：迁移前务必备份 Supabase 数据
- **监控**：开通云监控，设置告警规则

祝迁移顺利！🎉
