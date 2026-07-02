# API 代理函数一键部署脚本

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  API 代理函数部署" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$region = "cn-hangzhou"
$serviceName = "api-proxy-service"
$functionName = "api-proxy"

# 检查阿里云 CLI 配置
Write-Host "[1/4] 检查阿里云 CLI 配置..." -ForegroundColor Yellow
try {
    $result = aliyun sts GetCallerIdentity 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "阿里云 CLI 未配置"
    }
    Write-Host "✓ 阿里云 CLI 配置成功" -ForegroundColor Green
} catch {
    Write-Host "✗ 错误: 请先运行 01-setup-cli.md 配置阿里云 CLI" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 创建函数计算服务
Write-Host "[2/4] 创建函数计算服务..." -ForegroundColor Yellow
try {
    $exists = aliyun fc GetService --ServiceName $serviceName 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ 服务 $serviceName 已存在" -ForegroundColor Green
    } else {
        aliyun fc CreateService --ServiceName $serviceName --Description "API Proxy Service"
        Write-Host "✓ 服务创建成功: $serviceName" -ForegroundColor Green
    }
} catch {
    Write-Host "⚠ 服务创建可能失败，请手动检查" -ForegroundColor Yellow
}

Write-Host ""

# 打包函数代码
Write-Host "[3/4] 打包函数代码..." -ForegroundColor Yellow
Push-Location function
try {
    if (Test-Path "api-proxy.zip") {
        Remove-Item "api-proxy.zip" -Force
    }
    Compress-Archive -Path * -DestinationPath "api-proxy.zip" -Force
    Write-Host "✓ 代码打包成功" -ForegroundColor Green
} finally {
    Pop-Location
}

Write-Host ""

# 部署函数
Write-Host "[4/4] 部署函数..." -ForegroundColor Yellow
try {
    $funcExists = $false
    try {
        aliyun fc GetFunction --ServiceName $serviceName --FunctionName $functionName 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $funcExists = $true
        }
    } catch {
        $funcExists = $false
    }

    if ($funcExists) {
        Write-Host "  更新函数..." -ForegroundColor Gray
        aliyun fc UpdateFunction `
            --ServiceName $serviceName `
            --FunctionName $functionName `
            --CodeZipFile "function\api-proxy.zip"
    } else {
        Write-Host "  创建函数..." -ForegroundColor Gray
        aliyun fc CreateFunction `
            --ServiceName $serviceName `
            --FunctionName $functionName `
            --Runtime nodejs18 `
            --Handler index.handler `
            --CodeZipFile "function\api-proxy.zip" `
            --MemorySize 512 `
            --Timeout 300
    }
    
    Write-Host "✓ 函数部署成功!" -ForegroundColor Green
} catch {
    Write-Host "✗ 函数部署失败: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  部署完成!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor White
Write-Host "  1. 在函数计算控制台配置环境变量 ZHANHU_API_KEY" -ForegroundColor Gray
Write-Host "  2. 获取函数调用 URL" -ForegroundColor Gray
Write-Host "  3. 更新前端的 api-client.ts" -ForegroundColor Gray
Write-Host ""
Write-Host "函数信息：" -ForegroundColor White
Write-Host "  服务名: $serviceName" -ForegroundColor Gray
Write-Host "  函数名: $functionName" -ForegroundColor Gray
Write-Host "  区域: $region" -ForegroundColor Gray
Write-Host ""
