#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TikTok视频下载API模块
提供简洁的函数接口，专为API调用设计
"""

import os
import glob
import yt_dlp
from typing import List, Dict, Optional
import logging

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def download_tiktok_videos(username: str, output_dir: str = "downloaded_videos", max_videos: int = 50) -> Dict:
    """
    下载TikTok用户的所有视频
    
    Args:
        username (str): TikTok用户名（不带@符号）
        output_dir (str): 视频保存的文件夹路径
        max_videos (int): 最大下载视频数量，默认50个
        
    Returns:
        Dict: 包含下载结果的字典
        {
            'success': bool,           # 是否成功
            'output_dir': str,         # 输出文件夹路径
            'total_videos': int,       # 总视频数
            'downloaded_count': int,   # 成功下载数
            'failed_count': int,       # 下载失败数
            'video_files': List[str],  # 下载的视频文件列表
            'error_message': str       # 错误信息（如有）
        }
    """
    
    # 验证输入参数
    if not username or not isinstance(username, str):
        return {
            'success': False,
            'output_dir': output_dir,
            'total_videos': 0,
            'downloaded_count': 0,
            'failed_count': 0,
            'video_files': [],
            'error_message': '用户名不能为空且必须是字符串'
        }
    
    if not isinstance(max_videos, int) or max_videos <= 0:
        max_videos = 50  # 默认值
    
    try:
        # 确保输出目录存在
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
            logger.info(f"创建输出目录: {output_dir}")
        
        # 获取视频列表
        logger.info(f"正在获取 @{username} 的视频列表...")
        video_list = _fetch_user_videos(username, max_videos)
        
        if not video_list:
            return {
                'success': False,
                'output_dir': output_dir,
                'total_videos': 0,
                'downloaded_count': 0,
                'failed_count': 0,
                'video_files': [],
                'error_message': '未找到任何视频或获取失败'
            }
        
        # 下载视频
        logger.info(f"开始下载 {len(video_list)} 个视频到: {output_dir}")
        downloaded_count, failed_count, video_files = _download_video_list(
            username, video_list, output_dir
        )
        
        # 清理非视频文件
        _clean_output_directory(output_dir)
        
        result = {
            'success': True,
            'output_dir': os.path.abspath(output_dir),
            'total_videos': len(video_list),
            'downloaded_count': downloaded_count,
            'failed_count': failed_count,
            'video_files': video_files,
            'error_message': None
        }
        
        logger.info(f"下载完成 - 成功: {downloaded_count}, 失败: {failed_count}")
        return result
        
    except Exception as e:
        error_msg = f"下载过程中发生错误: {str(e)}"
        logger.error(error_msg)
        return {
            'success': False,
            'output_dir': output_dir,
            'total_videos': 0,
            'downloaded_count': 0,
            'failed_count': 0,
            'video_files': [],
            'error_message': error_msg
        }


def _fetch_user_videos(username: str, max_videos: int) -> List[Dict]:
    """获取用户视频列表"""
    try:
        ydl_opts = {
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.tiktok.com/',
            },
            'extract_flat': True,
            'quiet': True,
            'no_warnings': True,
            'playlistend': max_videos,
        }
        
        url = f"https://www.tiktok.com/@{username}"
        videos = []
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            if 'entries' in info:
                for entry in info['entries']:
                    if entry:
                        video_info = {
                            'id': entry.get('id', ''),
                            'title': entry.get('title', '无标题'),
                            'url': entry.get('url', '') or entry.get('webpage_url', ''),
                            'duration': entry.get('duration', 0),
                        }
                        videos.append(video_info)
        
        return videos
        
    except Exception as e:
        logger.error(f"获取视频列表失败: {e}")
        return []


def _download_video_list(username: str, videos: List[Dict], output_dir: str) -> tuple:
    """下载视频列表"""
    downloaded_count = 0
    failed_count = 0
    video_files = []
    
    ydl_opts = {
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/',
        },
        'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
        'format': 'best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': False,
    }
    
    for i, video in enumerate(videos, 1):
        try:
            logger.info(f"[{i}/{len(videos)}] 下载: {video['title'][:30]}...")
            video_url = f"https://www.tiktok.com/@{username}/video/{video['id']}"
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([video_url])
                downloaded_count += 1
                
                # 记录下载的文件
                candidates = glob.glob(os.path.join(output_dir, f"{video['id']}.*"))
                candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
                for path in candidates:
                    _, ext = os.path.splitext(path)
                    if ext.lower() in {".mp4", ".webm", ".mkv", ".avi", ".mov"} and os.path.exists(path):
                        video_files.append(path)
                        break
                
        except Exception as e:
            failed_count += 1
            logger.warning(f"下载失败 {video['id']}: {e}")
    
    return downloaded_count, failed_count, video_files


def _clean_output_directory(output_dir: str):
    """清理输出目录，只保留视频文件"""
    if not os.path.exists(output_dir):
        return
    
    video_extensions = {'.mp4', '.webm', '.mkv', '.avi', '.mov'}
    removed_count = 0
    
    for filename in os.listdir(output_dir):
        file_path = os.path.join(output_dir, filename)
        if os.path.isfile(file_path):
            _, ext = os.path.splitext(filename)
            if ext.lower() not in video_extensions:
                try:
                    os.remove(file_path)
                    removed_count += 1
                except Exception as e:
                    logger.warning(f"删除文件失败 {filename}: {e}")
    
    if removed_count > 0:
        logger.info(f"清理了 {removed_count} 个非视频文件")


def get_output_directory_info(output_dir: str) -> Dict:
    """
    获取输出目录的信息
    
    Args:
        output_dir (str): 输出目录路径
        
    Returns:
        Dict: 目录信息
    """
    if not os.path.exists(output_dir):
        return {
            'exists': False,
            'video_count': 0,
            'total_size': 0,
            'video_files': []
        }
    
    video_extensions = {'.mp4', '.webm', '.mkv', '.avi', '.mov'}
    video_files = []
    total_size = 0
    
    for filename in os.listdir(output_dir):
        file_path = os.path.join(output_dir, filename)
        if os.path.isfile(file_path):
            _, ext = os.path.splitext(filename)
            if ext.lower() in video_extensions:
                file_size = os.path.getsize(file_path)
                video_files.append({
                    'filename': filename,
                    'path': file_path,
                    'size': file_size
                })
                total_size += file_size
    
    return {
        'exists': True,
        'video_count': len(video_files),
        'total_size': total_size,
        'video_files': video_files
    }


# 使用示例
if __name__ == "__main__":
    # 示例调用
    result = download_tiktok_videos("ryougagagaga", "my_videos", 2)
    print("下载结果:", result)
    
    # 获取目录信息
    dir_info = get_output_directory_info("my_videos")
    print("目录信息:", dir_info)
