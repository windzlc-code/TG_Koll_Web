#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TikTok视频下载API包装器
专门为Web API和服务调用设计的简洁接口
"""

from simple_video_downloader import download_tiktok_videos, get_output_directory_info
from typing import Dict, Any
import json
import os

class TikTokAPIWrapper:
    """TikTok视频下载API包装器类"""
    
    @staticmethod
    def download_videos_api(username: str, output_dir: str = "api_downloads", max_videos: int = 30) -> Dict[str, Any]:
        """
        API接口：下载TikTok用户视频
        
        Args:
            username (str): TikTok用户名（不带@符号）
            output_dir (str): 输出目录名称
            max_videos (int): 最大下载数量
            
        Returns:
            Dict: API响应格式
        """
        try:
            # 调用核心下载函数
            result = download_tiktok_videos(username, output_dir, max_videos)
            
            # 格式化API响应
            api_response = {
                "status": "success" if result['success'] else "error",
                "data": {
                    "output_directory": result['output_dir'],
                    "statistics": {
                        "total_videos": result['total_videos'],
                        "downloaded_count": result['downloaded_count'],
                        "failed_count": result['failed_count']
                    },
                    "video_files": result['video_files']
                }
            }
            
            if not result['success']:
                api_response["error"] = result['error_message']
                
            return api_response
            
        except Exception as e:
            return {
                "status": "error",
                "error": f"API调用异常: {str(e)}",
                "data": None
            }
    
    @staticmethod
    def get_directory_info_api(output_dir: str) -> Dict[str, Any]:
        """
        API接口：获取目录信息
        
        Args:
            output_dir (str): 目录路径
            
        Returns:
            Dict: 目录信息API响应
        """
        try:
            info = get_output_directory_info(output_dir)
            
            api_response = {
                "status": "success",
                "data": {
                    "directory_exists": info['exists'],
                    "video_count": info['video_count'],
                    "total_size_bytes": info['total_size'],
                    "total_size_mb": round(info['total_size'] / (1024 * 1024), 2) if info['total_size'] > 0 else 0,
                    "videos": [
                        {
                            "filename": video['filename'],
                            "path": video['path'],
                            "size_bytes": video['size'],
                            "size_mb": round(video['size'] / (1024 * 1024), 2)
                        }
                        for video in info['video_files']
                    ]
                }
            }
            
            return api_response
            
        except Exception as e:
            return {
                "status": "error",
                "error": f"获取目录信息异常: {str(e)}",
                "data": None
            }
    
    @staticmethod
    def health_check() -> Dict[str, Any]:
        """健康检查接口"""
        return {
            "status": "healthy",
            "service": "TikTok Video Downloader API",
            "version": "1.0.0"
        }


# Flask API示例（如果需要）
"""
from flask import Flask, request, jsonify

app = Flask(__name__)
api_wrapper = TikTokAPIWrapper()

@app.route('/health', methods=['GET'])
def health():
    return jsonify(api_wrapper.health_check())

@app.route('/download', methods=['POST'])
def download_videos():
    data = request.get_json()
    username = data.get('username')
    output_dir = data.get('output_dir', 'api_downloads')
    max_videos = data.get('max_videos', 30)
    
    if not username:
        return jsonify({
            "status": "error",
            "error": "用户名不能为空"
        }), 400
    
    result = api_wrapper.download_videos_api(username, output_dir, max_videos)
    status_code = 200 if result['status'] == 'success' else 500
    return jsonify(result), status_code

@app.route('/directory/<path:dir_path>', methods=['GET'])
def get_directory_info(dir_path):
    result = api_wrapper.get_directory_info_api(dir_path)
    status_code = 200 if result['status'] == 'success' else 500
    return jsonify(result), status_code

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
"""

# FastAPI示例（如果需要）
"""
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="TikTok Video Downloader API")
api_wrapper = TikTokAPIWrapper()

class DownloadRequest(BaseModel):
    username: str
    output_dir: Optional[str] = "api_downloads"
    max_videos: Optional[int] = 30

@app.get("/health")
async def health_check():
    return api_wrapper.health_check()

@app.post("/download")
async def download_videos(request: DownloadRequest):
    return api_wrapper.download_videos_api(
        request.username, 
        request.output_dir, 
        request.max_videos
    )

@app.get("/directory/{dir_path}")
async def get_directory_info(dir_path: str):
    return api_wrapper.get_directory_info_api(dir_path)
"""

# 直接使用示例
if __name__ == "__main__":
    # 创建API包装器实例
    api = TikTokAPIWrapper()
    
    # 示例1: 下载视频
    print("=== 下载视频示例 ===")
    result = api.download_videos_api("test_user", "sample_videos", 5)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    # 示例2: 获取目录信息
    print("\n=== 目录信息示例 ===")
    dir_info = api.get_directory_info_api("sample_videos")
    print(json.dumps(dir_info, ensure_ascii=False, indent=2))
    
    # 示例3: 健康检查
    print("\n=== 健康检查 ===")
    health = api.health_check()
    print(json.dumps(health, ensure_ascii=False, indent=2))