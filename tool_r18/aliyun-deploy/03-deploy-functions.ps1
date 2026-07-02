# Next Chapter - 函数计算部署脚本
# 请确保已创建好函数计算服务

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  部署函数计算" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$fcServiceName = "next-chapter-service"
$functions = @("api-proxy", "parse-document", "projects-api")

# 检查函数计算服务是否存在
Write-Host "检查函数计算服务..." -ForegroundColor Yellow
try {
    $exists = aliyun fc GetService --ServiceName $fcServiceName 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "函数计算服务不存在，请先运行 02-create-services.ps1"
    }
    Write-Host "✓ 函数计算服务存在" -ForegroundColor Green
} catch {
    Write-Host "✗ 错误: 函数计算服务不存在" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 部署每个函数
foreach ($func in $functions) {
    Write-Host "部署函数: $func" -ForegroundColor Yellow
    
    $funcPath = "functions\$func"
    if (-not (Test-Path $funcPath)) {
        Write-Host "✗ 错误: 函数目录不存在: $funcPath" -ForegroundColor Red
        continue
    }
    
    Push-Location $funcPath
    
    try {
        # 安装依赖
        if (Test-Path "package.json") {
            Write-Host "  安装 npm 依赖..." -ForegroundColor Gray
            npm install
        }
        
        # 打包
        Write-Host "  打包代码..." -ForegroundColor Gray
        $zipFile = "$func.zip"
        if (Test-Path $zipFile) {
            Remove-Item $zipFile -Force
        }
        
        # 使用 Compress-Archive 打包
        Compress-Archive -Path * -DestinationPath $zipFile -Force
        
        # 检查函数是否存在
        $funcExists = $false
        try {
            aliyun fc GetFunction --ServiceName $fcServiceName --FunctionName $func 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $funcExists = $true
            }
        } catch {
            $funcExists = $false
        }
        
        # 创建或更新函数
        if ($funcExists) {
            Write-Host "  更新函数..." -ForegroundColor Gray
            aliyun fc UpdateFunction `
                --ServiceName $fcServiceName `
                --FunctionName $func `
                --CodeZipFile $zipFile
        } else {
            Write-Host "  创建函数..." -ForegroundColor Gray
            aliyun fc CreateFunction `
                --ServiceName $fcServiceName `
                --FunctionName $func `
                --Runtime nodejs18 `
                --Handler index.handler `
                --CodeZipFile $zipFile `
                --MemorySize 512 `
                --Timeout 300
        }
        
        Write-Host "✓ 函数 $func 部署成功!" -ForegroundColor Green
        
    } catch {
        Write-Host "✗ 函数 $func 部署失败: $_" -ForegroundColor Red
    } finally {
        Pop-Location
    }
    
    Write-Host ""
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  函数部署完成!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor White
Write-Host "  1. 在函数计算控制台配置环境变量" -ForegroundColor Gray
Write-Host "  2. 配置 API 网关（参考 api-gateway.md）" -ForegroundColor Gray
Write-Host ""
