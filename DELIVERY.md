# 交付说明

## 运行环境

- Python 3.10+
- Linux/macOS
- 系统需安装 `ffmpeg` 和 `ffprobe`

## 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

## 启动服务

```bash
source .venv/bin/activate
uvicorn webapp.server:app --host 0.0.0.0 --port 8000
```

## Windows 桌面版

已提供桌面入口和 Windows 打包脚本：

- 桌面入口：`desktop_launcher.py`
- 一键启动：`start.bat`
- 构建脚本：`build_windows_desktop.bat`
- 详细说明：`WINDOWS_DESKTOP.md`

需要在 Windows 机器上运行构建脚本，生成 `dist\WorkflowDesktop\WorkflowDesktop.exe`。

## 页面入口

- 用户端：`/console.html`
- 管理端：`/admin.html`
- 登录页：`/login.html`

## 数据目录

- 默认数据目录：`./webapp_data`
- 可通过环境变量 `WEBAPP_DATA_DIR` 覆盖

## 交付包说明

- 已排除本地数据库、上传文件、生成结果、缓存和测试产物
- 已排除运行时密钥和本地配置文件
- 如需上线，请在目标服务器自行准备运行配置
