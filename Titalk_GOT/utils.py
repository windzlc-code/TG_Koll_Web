"""
工具函數模塊
"""

import os
import json
from typing import Dict, Optional

def load_config(config_path: str = None) -> Dict:
    """加載配置文件（優先從 vedio 目錄讀取）"""
    if config_path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.join(script_dir, 'config.json')
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}

def save_config(config: Dict, config_path: str = 'config.json'):
    """保存配置文件"""
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

def get_gemini_api_key() -> Optional[str]:
    """獲取Gemini API Key"""
    # 優先從環境變量獲取
    api_key = os.getenv('GEMINI_API_KEY')
    if api_key:
        return api_key
    
    # 從配置文件獲取
    config = load_config()
    return config.get('gemini_api_key', '')

def format_number(num: int) -> str:
    """格式化數字顯示"""
    if num >= 1000000:
        return f"{num/1000000:.1f}M"
    elif num >= 1000:
        return f"{num/1000:.1f}K"
    return str(num)

def sanitize_filename(filename: str) -> str:
    """清理文件名，移除非法字符"""
    illegal_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
    for char in illegal_chars:
        filename = filename.replace(char, '_')
    return filename
