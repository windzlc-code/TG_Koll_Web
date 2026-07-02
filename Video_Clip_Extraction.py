import os
from typing import Union

def extract_frame_at_timestamp(
    video_path: str, 
    timestamp: Union[str, float], 
    output_path: str = None
) -> str:
    """
    从视频中提取指定时间戳的帧并保存为PNG图片
    
    参数:
        video_path (str): 视频文件路径
        timestamp (str or float): 时间戳，支持格式：
            - 字符串格式："00.04" 表示0分0.04秒
            - 字符串格式："1:30.5" 表示1分30.5秒  
            - 字符串格式："01.09.00" 表示1分9秒00毫秒
            - 浮点数：直接表示秒数
        output_path (str, optional): 输出图片路径，默认为视频同目录下以时间戳命名的PNG文件
    
    返回:
        str: 保存的图片文件路径
    
    示例:
        extract_frame_at_timestamp("video.mp4", "00.04")
        extract_frame_at_timestamp("video.mp4", 25.5)
        extract_frame_at_timestamp("video.mp4", "1:30.5", "output.png")
    """
    
    # 输入验证
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"视频文件不存在: {video_path}")
    
    # 解析时间戳
    if isinstance(timestamp, str):
        # 处理字符串格式的时间戳
        if ':' in timestamp:
            # 格式如 "1:30.5" (分钟:秒)
            parts = timestamp.split(':')
            if len(parts) == 2:
                minutes = float(parts[0])
                seconds = float(parts[1])
                target_time = minutes * 60 + seconds
            else:
                raise ValueError(f"无效的时间戳格式: {timestamp}")
        elif timestamp.count('.') == 2:
            # 格式如 "01.09.00" (分钟.秒.毫秒)
            parts = timestamp.split('.')
            if len(parts) == 3:
                minutes = float(parts[0])
                seconds = float(parts[1])
                milliseconds = float(parts[2])
                target_time = minutes * 60 + seconds + milliseconds / 1000
            else:
                raise ValueError(f"无效的时间戳格式: {timestamp}")
        else:
            # 格式如 "00.04", "08.00", "8" 等
            # 智能解析：如果包含小数点且前面有00，可能是0.x秒；否则按秒处理
            if '.' in timestamp:
                # 检查是否是 "00.x" 格式
                if timestamp.startswith('00.'):
                    target_time = float(timestamp)  # 00.08 -> 0.08秒
                else:
                    target_time = float(timestamp)  # 08.00 -> 8.00秒
            else:
                target_time = float(timestamp)  # "8" -> 8秒
    else:
        # 直接是秒数
        target_time = float(timestamp)
    
    if target_time < 0:
        raise ValueError("时间戳不能为负数")
    
    try:
        import cv2
    except ModuleNotFoundError as exc:
        raise RuntimeError("缺少 opencv-python（cv2），请先安装依赖后再运行。") from exc

    # 打开视频文件
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        raise ValueError(f"无法打开视频文件: {video_path}")
    
    # 获取视频信息
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps and fps > 0 and total_frames > 0:
        duration = total_frames / fps
    else:
        duration = None
    
    # 验证时间戳是否在视频范围内
    if duration is not None and target_time > duration:
        cap.release()
        raise ValueError(f"时间戳 {target_time}秒 超出视频时长 {duration:.2f}秒")
    
    if fps and fps > 0:
        target_frame = int(round(target_time * fps))
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(target_frame, 0))
    else:
        target_msec = target_time * 1000
        cap.set(cv2.CAP_PROP_POS_MSEC, max(target_msec, 0))
    
    # 读取帧
    ret, frame = cap.read()
    
    if not ret:
        # 尝试重新定位并重试
        if fps and fps > 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(int(round(target_time * fps)), 0))
        else:
            cap.set(cv2.CAP_PROP_POS_MSEC, max(target_time * 1000, 0))
        ret, frame = cap.read()
        
    if not ret:
        cap.release()
        raise RuntimeError(f"无法读取时间戳 {target_time}秒 的帧")
    
    # 生成默认输出路径
    if output_path is None:
        video_dir = os.path.dirname(video_path)
        video_name = os.path.splitext(os.path.basename(video_path))[0]
        # 将时间戳转换为安全的文件名
        time_str = str(timestamp).replace(':', '_').replace('.', '_')
        output_path = os.path.join(video_dir, f"{video_name}_frame_{time_str}.png")
    
    # 保存图片
    success = cv2.imwrite(output_path, frame)
    
    # 清理资源
    cap.release()
    
    if not success:
        raise RuntimeError(f"保存图片失败: {output_path}")
    
    print(f"成功提取帧到: {output_path}")
    return output_path


def batch_extract_frames(video_path: str, timestamps: list, output_dir: str = None) -> list:
    """
    批量提取多个时间戳的帧
    
    参数:
        video_path (str): 视频文件路径
        timestamps (list): 时间戳列表
        output_dir (str, optional): 输出目录
    
    返回:
        list: 成功保存的图片路径列表
    """
    saved_paths = []
    
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    for i, timestamp in enumerate(timestamps):
        try:
            if output_dir:
                video_name = os.path.splitext(os.path.basename(video_path))[0]
                time_str = str(timestamp).replace(':', '_').replace('.', '_')
                output_path = os.path.join(output_dir, f"{video_name}_frame_{i}_{time_str}.png")
            else:
                output_path = None
                
            saved_path = extract_frame_at_timestamp(video_path, timestamp, output_path)
            saved_paths.append(saved_path)
            
        except Exception as e:
            print(f"提取时间戳 {timestamp} 失败: {e}")
    
    return saved_paths


# 使用示例
if __name__ == "__main__":
    # 示例1: 提取单个帧
    try:
        # 不同时间格式示例
        examples = [
            "00.09.00",  # 0分9秒00毫秒 = 9秒
            "01.09.00",  # 1分9秒00毫秒 = 69秒  
            "02.30.50",  # 2分30秒50毫秒 = 150.5秒
            "1:30.5",    # 1分30.5秒（冒号格式）
            "90.0",      # 90.0秒
        ]
        
        for ts in examples:
            try:
                result = extract_frame_at_timestamp(
                    video_path="/Users/tangsong/Desktop/13412939779049453.mp4",
                    timestamp=ts
                )
                print(f"时间 {ts} -> 保存路径: {result}")
            except Exception as e:
                print(f"时间 {ts} 提取失败: {e}")
                
    except Exception as e:
        print(f"错误: {e}")
