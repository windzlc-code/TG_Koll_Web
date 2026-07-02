# Next Chapter - 阿里云服务一键开通脚本
# 请先配置好阿里云 CLI：参考 01-setup-aliyun-cli.md

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Next Chapter 阿里云服务开通脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$region = "cn-hangzhou"
$projectName = "next-chapter"

# 检查阿里云 CLI 是否配置
Write-Host "[1/6] 检查阿里云 CLI 配置..." -ForegroundColor Yellow
try {
    $result = aliyun sts GetCallerIdentity 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "阿里云 CLI 未配置或配置错误"
    }
    Write-Host "✓ 阿里云 CLI 配置成功!" -ForegroundColor Green
    Write-Host "  Account ID: $($result.AccountId)" -ForegroundColor Gray
} catch {
    Write-Host "✗ 错误: 请先运行 01-setup-aliyun-cli.md 配置阿里云 CLI" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 2. 创建 OSS Bucket
Write-Host "[2/6] 创建 OSS Bucket..." -ForegroundColor Yellow
$bucketName = "$projectName-storage-$region"
try {
    $exists = aliyun oss ls "oss://$bucketName" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ OSS Bucket $bucketName 已存在，跳过创建" -ForegroundColor Green
    } else {
        aliyun oss mb "oss://$bucketName" --region $region --acl private
        Write-Host "✓ OSS Bucket 创建成功: $bucketName" -ForegroundColor Green
    }
} catch {
    Write-Host "⚠ OSS Bucket 创建可能失败，请手动检查" -ForegroundColor Yellow
}

Write-Host ""

# 3. 检查 RDS 实例（需要手动创建，因为费用较高）
Write-Host "[3/6] RDS PostgreSQL 实例" -ForegroundColor Yellow
Write-Host "⚠ 注意：RDS 实例需要手动创建（涉及计费）" -ForegroundColor Yellow
Write-Host "请按以下步骤操作：" -ForegroundColor White
Write-Host "  1. 访问 https://rdsnext.console.aliyun.com/" -ForegroundColor Gray
Write-Host "  2. 创建 PostgreSQL 15.0 实例" -ForegroundColor Gray
Write-Host "  3. 实例规格：pg.n2.medium.2c (2核4GB)" -ForegroundColor Gray
Write-Host "  4. 存储空间：20GB" -ForegroundColor Gray
Write-Host "  5. 实例名称：$projectName-db" -ForegroundColor Gray
Write-Host "  6. 创建后，设置白名单允许公网访问" -ForegroundColor Gray
Write-Host ""

# 4. 创建函数计算服务
Write-Host "[4/6] 创建函数计算服务..." -ForegroundColor Yellow
$fcServiceName = "$projectName-service"
try {
    $exists = aliyun fc GetService --ServiceName $fcServiceName 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ 函数计算服务 $fcServiceName 已存在，跳过创建" -ForegroundColor Green
    } else {
        aliyun fc CreateService --ServiceName $fcServiceName --Description "Next Chapter API Service"
        Write-Host "✓ 函数计算服务创建成功: $fcServiceName" -ForegroundColor Green
    }
} catch {
    Write-Host "⚠ 函数计算服务创建可能失败，请手动检查" -ForegroundColor Yellow
}

Write-Host ""

# 5. API 网关（需要手动配置）
Write-Host "[5/6] API 网关" -ForegroundColor Yellow
Write-Host "⚠ API 网关需要后续手动配置" -ForegroundColor Yellow
Write-Host "请参考 api-gateway.md 文档进行配置" -ForegroundColor Gray
Write-Host ""

# 6. 总结
Write-Host "[6/6] 完成！" -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  已完成的服务：" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ✓ OSS Bucket: $bucketName" -ForegroundColor Green
Write-Host "  ✓ 函数计算服务: $fcServiceName" -ForegroundColor Green
Write-Host ""
Write-Host "  需要手动创建：" -ForegroundColor Yellow
Write-Host "  ⚠ RDS PostgreSQL 实例" -ForegroundColor Yellow
Write-Host "  ⚠ API 网关配置" -ForegroundColor Yellow
Write-Host ""
Write-Host "下一步：" -ForegroundColor White
Write-Host "  1. 创建 RDS 实例（见上方说明）" -ForegroundColor Gray
Write-Host "  2. 运行 03-deploy-functions.ps1 部署函数" -ForegroundColor Gray
Write-Host ""
