# Windows Desktop Build

这个项目现在可以用 `desktop_launcher.py` 作为桌面入口：它会启动本机 FastAPI 服务，并用 pywebview 打开桌面窗口。

同时提供了直接双击的启动脚本：

- `start.bat`：桌面版一键启动
- `start.bat --check`：检查 Python / 虚拟环境 / 依赖
- `start.bat --debug`：保留控制台输出，便于排查启动问题

## 构建环境

- Windows 10/11
- Python 3.10 或更高版本
- Microsoft Edge WebView2 Runtime
- 如需视频切分/拼接功能，安装 ffmpeg 并确保 `ffmpeg.exe`、`ffprobe.exe` 在 `PATH` 中

也可以在项目根目录新建 `bin` 文件夹，把 `ffmpeg.exe` 和 `ffprobe.exe` 放进去再构建，打包后的程序会优先使用随包的 `bin`。

## 一键构建

在 Windows 上双击或命令行运行：

```bat
build_windows_desktop.bat
```

生成结果：

```text
dist\WorkflowDesktop\WorkflowDesktop.exe
```

打包时会自动生成并嵌入桌面图标资源：

```text
desktop_assets\desktop-icon.ico
desktop_assets\desktop-icon.png
```

发布时复制整个 `dist\WorkflowDesktop` 文件夹，不要只复制单个 exe。

## 手动构建

```bat
py -3.10 -m venv .venv-desktop
call .venv-desktop\Scripts\activate.bat
python -m pip install -U pip
python -m pip install -r requirements-desktop.txt
python -m PyInstaller --clean --noconfirm desktop_app.spec
```

## 运行数据

桌面版会把数据库、上传文件、输出文件和运行配置放到：

```text
%LOCALAPPDATA%\WorkflowDesktop\webapp_data
```

可以用环境变量覆盖：

```bat
set WORKFLOW_DESKTOP_DATA_DIR=D:\WorkflowDesktopData
```

首次启动会自动创建 `runtime_config.json`、SQLite 数据库和默认管理员账号。

如果桌面窗口因为 WebView 环境问题无法打开，程序会自动回退到系统浏览器。

如果启动失败，会把异常写到：

```text
%LOCALAPPDATA%\WorkflowDesktop\startup-error.log
```
