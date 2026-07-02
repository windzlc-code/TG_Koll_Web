#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TikTok视频下载API使用示例
演示如何直接调用API函数
"""

from tiktok_api_wrapper import TikTokAPIWrapper
import json

def demo_basic_usage():
    """基础使用演示"""
    print("=== TikTok视频下载API基础使用演示 ===\n")
    
    # 创建API实例
    api = TikTokAPIWrapper()
    
    # 1. 健康检查
    print("1. 健康检查:")
    health_result = api.health_check()
    print(json.dumps(health_result, ensure_ascii=False, indent=2))
    print()
    
    # 2. 下载视频（使用测试用户名）
    print("2. 下载视频示例:")
    # 注意：这里使用示例用户名，实际使用时请替换为真实用户名
    download_result = api.download_videos_api(
        username="example_user",  # 替换为实际的TikTok用户名
        output_dir="my_downloaded_videos",
        max_videos=5  # 限制下载数量
    )
    print(json.dumps(download_result, ensure_ascii=False, indent=2))
    print()
    
    # 3. 获取目录信息
    print("3. 获取目录信息:")
    dir_info = api.get_directory_info_api("my_downloaded_videos")
    print(json.dumps(dir_info, ensure_ascii=False, indent=2))

def demo_direct_function_call():
    """直接调用核心函数演示"""
    print("\n=== 直接调用核心函数演示 ===\n")
    
    from simple_video_downloader import download_tiktok_videos, get_output_directory_info
    
    # 直接调用下载函数
    result = download_tiktok_videos(
        username="example_user",
        output_dir="direct_call_videos",
        max_videos=3
    )
    
    print("下载结果:")
    print(f"  成功: {result['success']}")
    print(f"  输出目录: {result['output_dir']}")
    print(f"  总视频数: {result['total_videos']}")
    print(f"  下载成功: {result['downloaded_count']}")
    print(f"  下载失败: {result['failed_count']}")
    
    if result['video_files']:
        print("  下载的文件:")
        for video_file in result['video_files']:
            print(f"    - {video_file}")

def demo_error_handling():
    """错误处理演示"""
    print("\n=== 错误处理演示 ===\n")
    
    api = TikTokAPIWrapper()
    
    # 测试空用户名
    print("测试空用户名:")
    result = api.download_videos_api("", "test_output")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    # 测试无效用户名
    print("\n测试无效用户名:")
    result = api.download_videos_api("nonexistent_user_12345", "test_output")
    print(json.dumps(result, ensure_ascii=False, indent=2))

def demo_practical_usage():
    """实际使用场景演示"""
    print("\n=== 实际使用场景演示 ===\n")
    
    api = TikTokAPIWrapper()
    
    # 场景1: 批量下载多个用户的视频
    users = ["user1", "user2", "user3"]  # 替换为实际用户名
    
    for i, username in enumerate(users, 1):
        print(f"处理第 {i} 个用户: @{username}")
        result = api.download_videos_api(
            username=username,
            output_dir=f"user_videos_{username}",
            max_videos=10
        )
        
        if result['status'] == 'success':
            print(f"  ✓ 成功下载 {result['data']['statistics']['downloaded_count']} 个视频")
            print(f"  保存路径: {result['data']['output_directory']}")
        else:
            print(f"  ✗ 下载失败: {result.get('error', '未知错误')}")
        print()

if __name__ == "__main__":
    # 运行所有演示
    demo_basic_usage()
    demo_direct_function_call()
    demo_error_handling()
    demo_practical_usage()
    
    print("\n=== 使用说明 ===")
    print("1. 请将示例中的 'example_user' 替换为真实的TikTok用户名")
    print("2. 确保已安装所需的依赖: pip install yt-dlp")
    print("3. 输出目录会自动创建，只包含视频文件")
    print("4. 可以根据需要调整 max_videos 参数控制下载数量")