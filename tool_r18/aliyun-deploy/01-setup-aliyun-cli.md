# 阿里云 CLI 配置指南

## 第一步：安装阿里云 CLI

### Windows (使用 PowerShell)

```powershell
# 方法一：使用 winget (推荐)
winget install Alibaba.AliyunCLI

# 方法二：下载安装包
# 访问 https://aliyuncli.alicdn.com/aliyun-cli-latest-windows-amd64.msi 下载安装
```

### 验证安装

```powershell
aliyun --version
```

## 第二步：获取 AccessKey

1. 登录 [阿里云控制台](https://ram.console.aliyun.com/)
2. 进入 "访问控制 RAM" → "用户"
3. 点击 "创建用户"
4. 用户名输入：`next-chapter-deploy`
5. 勾选 "OpenAPI 调用访问"
6. 点击 "确定"
7. **重要**：保存生成的 AccessKey ID 和 AccessKey Secret（只显示一次！）

## 第三步：给用户授权

1. 在用户列表中找到刚创建的 `next-chapter-deploy`
2. 点击 "添加权限"
3. 添加以下系统策略：
   - `AliyunRDSFullAccess` - RDS 全权限
   - `AliyunOSSFullAccess` - OSS 全权限
   - `AliyunFCFullAccess` - 函数计算全权限
   - `AliyunAPIGatewayFullAccess` - API 网关全权限
   - `AliyunRAMFullAccess` - RAM 访问权限（可选）

## 第四步：配置阿里云 CLI

```powershell
# 配置默认配置
aliyun configure set --profile default \
  --mode AK \
  --region cn-hangzhou \
  --access-key-id <你的AccessKeyId> \
  --access-key-secret <你的AccessKeySecret>

# 验证配置
aliyun sts GetCallerIdentity
```

## 第五步：运行开通脚本

配置好 CLI 后，运行：

```powershell
cd aliyun-deploy
.\02-create-services.ps1
```

## 常见问题

### 配置后还是提示无权限？
- 确保给用户添加了正确的权限策略
- 等待 1-2 分钟让权限生效

### AccessKey 忘了保存怎么办？
- 可以在 RAM 控制台创建新的 AccessKey
- 禁用旧的 AccessKey
