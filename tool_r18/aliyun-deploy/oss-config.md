# OSS 配置指南

## 1. 创建 Bucket

```bash
# 使用阿里云 CLI 创建 Bucket
aliyun oss mb oss://next-chapter-storage \
  --region cn-hangzhou \
  --acl private
```

## 2. 配置 CORS

在 OSS 控制台配置以下 CORS 规则：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>x-oss-request-id</ExposeHeader>
    <MaxAgeSeconds>300</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

## 3. 创建 RAM 用户和权限

创建一个专门用于 OSS 访问的 RAM 用户，并授予以下权限：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:DeleteObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:next-chapter-storage/*"
      ]
    }
  ]
}
```

## 4. 生成 STS 临时凭证（可选）

如果需要前端直接上传文件到 OSS，建议使用 STS 临时凭证：

```javascript
const OSS = require('ali-oss');

const sts = new OSS.STS({
  accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
});

async function getStsToken() {
  const token = await sts.assumeRole(
    'acs:ram::<account-id>:role/oss-upload-role',
    null,
    3600,
    'session-name'
  );
  return token.credentials;
}
```

## 5. 环境变量配置

在函数计算中配置以下环境变量：

```
OSS_BUCKET=next-chapter-storage
OSS_REGION=cn-hangzhou
ALIYUN_ACCESS_KEY_ID=your-access-key-id
ALIYUN_ACCESS_KEY_SECRET=your-access-key-secret
```
