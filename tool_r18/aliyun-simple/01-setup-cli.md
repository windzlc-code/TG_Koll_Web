# 阿里云 CLI 配置指南

## 第一步：安装阿里云 CLI

```powershell
winget install Alibaba.AliyunCLI
```

验证安装：
```powershell
aliyun --version
```

## 第二步：创建 RAM 用户并获取 AccessKey

1. 访问 https://ram.console.aliyun.com/
2. 点击"创建用户"
   - 用户名：`api-proxy-deploy`
   - 勾选"OpenAPI 调用访问"
3. **重要！** 保存 AccessKey ID 和 AccessKey Secret（只显示一次）
4. 给用户添加权限：
   - `AliyunFCFullAccess` - 函数计算全权限

## 第三步：配置阿里云 CLI

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

## 第四步：获取站狐 API Key

在项目设置中找到你的站狐 API Key，后续需要配置到函数计算中。

---

配置好 CLI 后，运行 `02-deploy-proxy.ps1` 部署函数！
