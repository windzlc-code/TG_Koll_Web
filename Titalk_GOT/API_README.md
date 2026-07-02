# TikTok视频下载API

## 📋 项目概述

这是一个专门为API调用设计的TikTok视频下载工具，提供简洁的函数接口，方便集成到各种应用中。

## 📁 文件结构

```
vedio/
├── simple_video_downloader.py    # 核心下载函数（推荐直接使用）
├── tiktok_api_wrapper.py         # API包装器类
├── api_usage_example.py          # 使用示例
└── main.py                      # 原始主程序
```

## 🚀 快速开始

### 1. 安装依赖
```bash
pip install yt-dlp
```

### 2. 直接调用核心函数（推荐）

```python
from simple_video_downloader import download_tiktok_videos

# 简单调用
result = download_tiktok_videos("用户名", "输出文件夹", 10)

print(f"成功下载: {result['downloaded_count']} 个视频")
print(f"保存路径: {result['output_dir']}")
```

### 3. 使用API包装器

```python
from tiktok_api_wrapper import TikTokAPIWrapper

api = TikTokAPIWrapper()

# 下载视频
result = api.download_videos_api("用户名", "输出文件夹", 10)
print(result)

# 获取目录信息
dir_info = api.get_directory_info_api("输出文件夹")
print(dir_info)
```

## 📊 返回数据格式

### 下载函数返回格式
```python
{
    'success': True,              # 是否成功
    'output_dir': '/path/to/dir', # 输出目录绝对路径
    'total_videos': 25,           # 总视频数
    'downloaded_count': 20,       # 成功下载数
    'failed_count': 5,            # 下载失败数
    'video_files': [              # 下载的视频文件列表
        '/path/to/dir/video1.mp4',
        '/path/to/dir/video2.mp4'
    ],
    'error_message': None         # 错误信息（如有）
}
```

### API包装器返回格式
```python
{
    "status": "success",          # success 或 error
    "data": {
        "output_directory": "/path/to/dir",
        "statistics": {
            "total_videos": 25,
            "downloaded_count": 20,
            "failed_count": 5
        },
        "video_files": [...]
    },
    "error": null                 # 错误信息（如有）
}
```

## 🔧 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| username | str | 必填 | TikTok用户名（不带@符号） |
| output_dir | str | "downloaded_videos" | 输出文件夹名称 |
| max_videos | int | 50 | 最大下载视频数量 |

## 🌐 Web API集成示例

### Flask示例
```python
from flask import Flask, request, jsonify
from tiktok_api_wrapper import TikTokAPIWrapper

app = Flask(__name__)
api = TikTokAPIWrapper()

@app.route('/download', methods=['POST'])
def download():
    data = request.get_json()
    result = api.download_videos_api(
        data['username'],
        data.get('output_dir', 'downloads'),
        data.get('max_videos', 30)
    )
    return jsonify(result)

if __name__ == '__main__':
    app.run(port=5000)
```

### FastAPI示例
```python
from fastapi import FastAPI
from pydantic import BaseModel
from tiktok_api_wrapper import TikTokAPIWrapper

app = FastAPI()
api = TikTokAPIWrapper()

class DownloadRequest(BaseModel):
    username: str
    output_dir: str = "downloads"
    max_videos: int = 30

@app.post("/download")
async def download_videos(request: DownloadRequest):
    return api.download_videos_api(
        request.username,
        request.output_dir,
        request.max_videos
    )
```

## ⚠️ 注意事项

1. **网络环境**：可能需要科学上网才能访问TikTok
2. **频率限制**：避免过于频繁的请求，以免被限制
3. **存储空间**：视频文件较大，请确保有足够的存储空间
4. **合规使用**：请遵守相关法律法规和平台使用条款

## 📝 错误处理

常见的错误情况：
- 用户名不存在或输入错误
- 网络连接问题
- 存储空间不足
- 权限不足

所有错误都会在返回结果中的 `error_message` 字段中详细说明。

## 🎯 使用场景

- 批量下载TikTok内容用于分析
- 构建自动化内容收集系统
- 集成到现有的内容管理系统
- 开发TikTok数据分析工具

这个API设计简洁明了，非常适合快速集成到各种应用中！