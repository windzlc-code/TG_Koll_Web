"""
TikTok 對標帳號分析與數字人應用
功能：
1. 對標帳號視頻提取
2. 視頻排序（最新、最多點讚、最多收藏、最多分享）
3. Gemini視頻分析和文案提取
4. AI文案修改避免重複
5. 數字人口型同步和語音克隆
"""

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext, filedialog
import threading
import os
import json
from datetime import datetime
from typing import List, Dict, Optional
import requests
from PIL import Image, ImageTk
from io import BytesIO
import yt_dlp

# #region agent log
def debug_log(location, message, data=None, hypothesis_id=None, run_id="initial"):
    try:
        log_entry = {
            "sessionId": "87dee4",
            "id": f"log_{int(datetime.now().timestamp() * 1000)}",
            "timestamp": int(datetime.now().timestamp() * 1000),
            "location": location,
            "message": message,
            "data": data or {},
            "runId": run_id,
            "hypothesisId": hypothesis_id
        }
        with open("debug-87dee4.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
# #endregion

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    genai = None
    print("警告: google-generativeai未安裝，Gemini功能將不可用")
    print("提示: 雖然 google-generativeai 已標記為 deprecated，但仍可使用")
    print("     如需使用最新功能，請安裝 google-genai: pip install google-genai")

try:
    # moviepy 2.x 版本可以直接從 moviepy 導入
    try:
        from moviepy import VideoFileClip
    except ImportError:
        # 兼容舊版本
        from moviepy.editor import VideoFileClip
    MOVIEPY_AVAILABLE = True
except ImportError as e:
    MOVIEPY_AVAILABLE = False
    print(f"警告: moviepy未安裝或導入失敗，視頻分析功能將受限: {e}")
    print("提示: 請運行 pip install moviepy")
except Exception as e:
    MOVIEPY_AVAILABLE = False
    print(f"警告: moviepy導入時發生錯誤: {e}")

try:
    import cv2
    import numpy as np
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    print("警告: opencv-python未安裝，部分功能將不可用")

# 配置模塊
class Config:
    def __init__(self):
        self.script_dir = os.path.dirname(os.path.abspath(__file__))
        self.gemini_api_key = os.getenv('GEMINI_API_KEY', '')
        self.videos_dir = os.path.join(self.script_dir, 'downloaded_videos')
        self.scripts_dir = os.path.join(self.script_dir, 'scripts')
        self.output_dir = os.path.join(self.script_dir, 'output')
        self.config_path = os.path.join(self.script_dir, 'config.json')
        self._ensure_dirs()
        self._ensure_config()
    
    def _ensure_config(self):
        """若無 config.json，從 config.json.example 複製一份"""
        if not os.path.exists(self.config_path):
            example = os.path.join(self.script_dir, 'config.json.example')
            if os.path.exists(example):
                import shutil
                shutil.copy(example, self.config_path)
    
    def _ensure_dirs(self):
        for dir_path in [self.videos_dir, self.scripts_dir, self.output_dir]:
            os.makedirs(dir_path, exist_ok=True)

def get_tiktok_ydl_base_opts():
    """返回用於 TikTok 的 yt-dlp 基礎選項，減少 403 Forbidden。"""
    opts = {
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
        },
    }
    # 若有 curl_cffi，啟用 impersonate 可進一步避免 403（pip install "yt-dlp[default,curl-cffi]" 後更新 yt-dlp）
    try:
        import curl_cffi
        opts['impersonate'] = 'chrome'
    except ImportError:
        pass
    return opts


# TikTok視頻獲取模塊
class TikTokFetcher:
    def __init__(self):
        self.videos_cache = {}
    
    def fetch_user_videos(self, username: str) -> List[Dict]:
        """獲取用戶的所有視頻"""
        try:
            # 方法1: 使用yt-dlp獲取用戶信息
            videos = self._fetch_with_ytdlp(username)
            if videos:
                return videos
            
            # 方法2: 使用備用方法
            return self._fetch_videos_fallback(username)
        except Exception as e:
            print(f"獲取視頻時出錯: {e}")
            return []
    
    def _fetch_with_ytdlp(self, username: str) -> List[Dict]:
        """使用yt-dlp獲取視頻"""
        try:
            ydl_opts = {
                **get_tiktok_ydl_base_opts(),
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False,  # 改為False以獲取完整信息包括縮略圖
                'playlistend': 50,  # 限制獲取數量
            }
            
            url = f"https://www.tiktok.com/@{username}"
            videos = []
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                
                if 'entries' in info:
                    for entry in info['entries']:
                        if entry:
                            video_id = entry.get('id', '')
                            thumbnail = entry.get('thumbnail', '')
                            
                            # 如果沒有縮略圖，嘗試構建TikTok縮略圖URL
                            if not thumbnail and video_id:
                                # TikTok縮略圖URL格式: https://p16-sign-va.tiktokcdn.com/...
                                # 但更簡單的方法是從視頻URL獲取
                                video_url = entry.get('url', '') or entry.get('webpage_url', '')
                                if video_url:
                                    # 嘗試獲取單個視頻的詳細信息以獲取縮略圖
                                    try:
                                        video_info = ydl.extract_info(video_url, download=False)
                                        thumbnail = video_info.get('thumbnail', '') or video_info.get('thumbnails', [{}])[0].get('url', '')
                                    except:
                                        pass
                            
                            video_info = {
                                'id': video_id,
                                'title': entry.get('title', '無標題'),
                                'url': entry.get('url', '') or entry.get('webpage_url', ''),
                                'duration': entry.get('duration', 0),
                                'view_count': entry.get('view_count', 0),
                                'like_count': entry.get('like_count', 0),
                                'comment_count': entry.get('comment_count', 0),
                                'upload_date': entry.get('upload_date', ''),
                                'thumbnail': thumbnail,
                                'share_count': entry.get('repost_count', 0),
                                'favorite_count': entry.get('like_count', 0),  # 如果沒有收藏數據，使用點讚數
                            }
                            videos.append(video_info)
            
            return videos
        except Exception as e:
            print(f"yt-dlp獲取失敗: {e}")
            return []
    
    def _fetch_videos_fallback(self, username: str) -> List[Dict]:
        """備用方法：使用網頁爬蟲或API"""
        # 這裡可以實現備用的爬蟲方法
        # 由於TikTok的反爬蟲機制，建議使用官方API或第三方服務
        print("提示: yt-dlp無法獲取視頻，請確保:")
        print("1. 用戶名正確")
        print("2. 網絡連接正常")
        print("3. 考慮使用TikTok官方API")
        return []

# Gemini分析模塊
class GeminiAnalyzer:
    def __init__(self, api_key: str):
        self.model = None
        self.text_model = None
        self.text_model_name = None  # 記錄成功初始化的模型名稱
        self.init_error = None
        
        if api_key and GEMINI_AVAILABLE and genai:
            try:
                # #region agent log
                debug_log("GeminiAnalyzer.__init__", "開始初始化Gemini", {"api_key_present": bool(api_key), "gemini_available": GEMINI_AVAILABLE}, "A", "initial")
                # #endregion
                genai.configure(api_key=api_key)
                # #region agent log
                debug_log("GeminiAnalyzer.__init__", "Gemini配置完成", {}, "A", "initial")
                # #endregion
                
                # 嘗試獲取可用模型列表
                available_models = []
                try:
                    # #region agent log
                    debug_log("GeminiAnalyzer.__init__", "嘗試獲取可用模型列表", {}, "E", "initial")
                    # #endregion
                    for m in genai.list_models():
                        if 'generateContent' in m.supported_generation_methods:
                            available_models.append(m.name)
                    # #region agent log
                    debug_log("GeminiAnalyzer.__init__", "獲取到的可用模型列表", {"available_models": available_models}, "E", "initial")
                    # #endregion
                except Exception as e:
                    # #region agent log
                    debug_log("GeminiAnalyzer.__init__", "獲取模型列表失敗", {"error": str(e)}, "E", "initial")
                    # #endregion
                    pass
                
                # 按優先順序嘗試模型名稱（移除已棄用的 gemini-pro 和不可用的 gemini-2.0-flash-exp）
                # 優先使用實際可用的模型
                text_models_to_try = [
                    'gemini-1.5-flash',
                    'gemini-1.5-pro',
                    'models/gemini-1.5-flash',
                    'models/gemini-1.5-pro',
                ]
                
                # 如果獲取到可用模型列表，優先使用列表中的模型
                if available_models:
                    # 過濾出文本生成模型，優先使用（排除不可用的模型）
                    excluded_models = ['gemini-2.0-flash-exp', 'models/gemini-2.0-flash-exp', 'gemini-pro', 'models/gemini-pro']
                    preferred_models = [
                        m for m in available_models 
                        if ('flash' in m.lower() or 'pro' in m.lower()) 
                        and not any(excluded in m.lower() for excluded in excluded_models)
                    ]
                    if preferred_models:
                        text_models_to_try = preferred_models[:4] + text_models_to_try
                
                vision_models_to_try = [
                    'gemini-1.5-flash',
                    'gemini-1.5-pro',
                    'models/gemini-1.5-flash',
                    'models/gemini-1.5-pro',
                ]
                
                # #region agent log
                debug_log("GeminiAnalyzer.__init__", "準備嘗試的文本模型列表", {
                    "models": text_models_to_try,
                    "available_models_count": len(available_models),
                    "available_models": available_models[:10] if available_models else []
                }, "A", "initial")
                # #endregion
                
                # 初始化文本模型
                text_model_errors = []
                for model_name in text_models_to_try:
                    try:
                        # #region agent log
                        debug_log("GeminiAnalyzer.__init__", f"嘗試初始化文本模型", {"model_name": model_name}, "A", "initial")
                        # #endregion
                        self.text_model = genai.GenerativeModel(model_name)
                        self.text_model_name = model_name  # 記錄成功使用的模型名稱
                        # 測試是否能正常調用
                        test_response = self.text_model.generate_content("test")
                        # #region agent log
                        debug_log("GeminiAnalyzer.__init__", "文本模型初始化成功", {"model_name": model_name, "model_object": str(type(self.text_model))}, "A", "initial")
                        # #endregion
                        print(f"成功使用文本模型: {model_name}")
                        break
                    except Exception as e:
                        error_msg = f"{model_name}: {str(e)}"
                        text_model_errors.append(error_msg)
                        # #region agent log
                        debug_log("GeminiAnalyzer.__init__", "文本模型初始化失敗", {"model_name": model_name, "error": str(e)}, "A", "initial")
                        # #endregion
                        continue
                
                # 初始化視覺模型（可選）
                vision_model_errors = []
                for model_name in vision_models_to_try:
                    try:
                        self.model = genai.GenerativeModel(model_name)
                        print(f"成功使用視覺模型: {model_name}")
                        break
                    except Exception as e:
                        error_msg = f"{model_name}: {str(e)}"
                        vision_model_errors.append(error_msg)
                        continue
                
                # #region agent log
                debug_log("GeminiAnalyzer.__init__", "模型初始化完成", {
                    "text_model_set": self.text_model is not None,
                    "text_model_type": str(type(self.text_model)) if self.text_model else None,
                    "vision_model_set": self.model is not None,
                    "text_model_errors_count": len(text_model_errors)
                }, "B", "initial")
                # #endregion
                
                # 如果所有模型都失敗，記錄錯誤
                if not self.text_model and text_model_errors:
                    print("文本模型初始化失敗，嘗試的模型:")
                    for err in text_model_errors:
                        print(f"  - {err}")
                
                if not self.text_model:
                    self.init_error = "無法找到可用的 Gemini 模型。請檢查 API Key 是否有效。"
                    print(self.init_error)
                    
            except Exception as e:
                self.init_error = f"Gemini 初始化失敗: {str(e)}"
                print(self.init_error)
        else:
            if not api_key:
                self.init_error = "未配置 Gemini API Key"
            elif not GEMINI_AVAILABLE:
                self.init_error = "google-generativeai 未安裝"
    
    def analyze_video(self, video_path: str, video_meta: Optional[Dict] = None) -> Dict:
        """分析視頻並提取文案"""
        if self.init_error:
            return {'error': f'Gemini 初始化錯誤: {self.init_error}'}
        
        if not self.text_model and not self.model:
            return {'error': 'Gemini API 未配置或模型不可用。請檢查 config.json 中的 gemini_api_key'}
        
        # 優先嘗試：僅用標題做 AI 分析（無需 moviepy）
        if video_meta and self.text_model:
            meta_result = self._analyze_from_metadata(video_meta)
            if meta_result:
                return meta_result
        
        # 需要 moviepy 做視覺分析
        if not MOVIEPY_AVAILABLE:
            return {'error': 'moviepy 未安裝。請運行: pip install moviepy'}
        
        if not os.path.exists(video_path):
            return {'error': f'視頻文件不存在: {video_path}'}
        
        try:
            video = VideoFileClip(video_path)
            duration = min(video.duration, 60)
            frames = []
            frame_times = [0, duration/3, duration*2/3, max(0, duration-1)]
            for t in frame_times:
                if t < duration:
                    try:
                        frame = video.get_frame(t)
                        frames.append(frame)
                    except Exception:
                        pass
            
            video.close()
            
            if self.model and frames:
                try:
                    from PIL import Image
                    pil_images = [Image.fromarray(f.astype('uint8')) for f in frames]
                    prompt = """請分析這個 TikTok 視頻截圖，用繁體中文回覆 JSON：
{"content": "視頻內容描述", "script": "提取的文案或字幕", "style": "視頻風格", "title": "建議標題", "description": "建議描述"}"""
                    response = self.model.generate_content([prompt] + pil_images[:1])
                    result_text = response.text
                    import re
                    m = re.search(r'\{[^{}]*\}', result_text, re.DOTALL)
                    if m:
                        import json
                        return json.loads(m.group())
                    return {
                        'script': result_text, 'content': '已分析', 'style': '自動', 'title': '視頻標題', 'description': result_text[:200]
                    }
                except Exception as e:
                    pass  # 繼續嘗試文本模型
            
            return self._analyze_with_text_model(video_path)
            
        except Exception as e:
            err = str(e)
            if video_meta and self.text_model:
                return self._analyze_from_metadata(video_meta) or {'error': f'分析失敗: {err}'}
            return {'error': f'分析失敗: {err}'}
    
    def _analyze_from_metadata(self, video_meta: Dict) -> Optional[Dict]:
        """僅用視頻元數據做 AI 文案建議（無需電影或視覺）"""
        # #region agent log
        debug_log("GeminiAnalyzer._analyze_from_metadata", "方法開始", {
            "text_model_exists": self.text_model is not None,
            "text_model_type": str(type(self.text_model)) if self.text_model else None,
            "init_error": self.init_error
        }, "B", "initial")
        # #endregion
        if not self.text_model:
            # #region agent log
            debug_log("GeminiAnalyzer._analyze_from_metadata", "text_model為None，返回None", {}, "C", "initial")
            # #endregion
            return None
        try:
            title = video_meta.get('title', '') or '未知標題'
            prompt = f"""根據以下 TikTok 視頻標題，生成一個適合的短視頻文案（約 50–100 字），用繁體中文，風格貼近原標題，格式為 JSON：
{{"title": "建議標題", "content": "內容簡述", "style": "風格", "script": "文案正文", "description": "簡短描述"}}
原標題：{title}"""
            # #region agent log
            debug_log("GeminiAnalyzer._analyze_from_metadata", "準備調用generate_content", {
                "model_type": str(type(self.text_model)),
                "prompt_length": len(prompt)
            }, "A", "initial")
            # #endregion
            response = self.text_model.generate_content(prompt)
            # #region agent log
            debug_log("GeminiAnalyzer._analyze_from_metadata", "generate_content調用成功", {"response_length": len(response.text) if response.text else 0}, "A", "initial")
            # #endregion
            text = response.text.strip()
            import re, json
            m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
            if m:
                return json.loads(m.group())
            return {
                'title': title, 'content': '', 'style': '未知', 'script': text[:300], 'description': ''
            }
        except Exception as e:
            # #region agent log
            debug_log("GeminiAnalyzer._analyze_from_metadata", "generate_content調用失敗", {
                "error": str(e),
                "error_type": str(type(e).__name__),
                "text_model_type": str(type(self.text_model)) if self.text_model else None
            }, "A", "initial")
            # #endregion
            print(f"_analyze_from_metadata 錯誤: {e}")
            return None
    
    def _analyze_with_text_model(self, video_path: str = None) -> Dict:
        """使用文本模型分析（備用方法）"""
        try:
            prompt = """請生成一個適合 TikTok 的短視頻文案範例（約50字），用繁體中文，格式為 JSON：{"title":"標題","content":"內容","style":"風格","script":"文案","description":"描述"}"""
            
            if self.text_model:
                response = self.text_model.generate_content(prompt)
                text = response.text.strip()
                import re, json
                m = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
                if m:
                    return json.loads(m.group())
                return {'script': text, 'content': '', 'style': '通用', 'title': '視頻標題', 'description': ''}
            return {'script': '請配置 Gemini API', 'content': '', 'style': '', 'title': '', 'description': ''}
        except Exception as e:
            return {'script': str(e), 'content': '', 'style': '', 'title': '', 'description': ''}
    
    def modify_script(self, original_script: str, style: str = '') -> str:
        """使用AI修改文案，避免重複"""
        # #region agent log
        debug_log("GeminiAnalyzer.modify_script", "方法開始", {
            "text_model_exists": self.text_model is not None,
            "text_model_name": self.text_model_name,
            "text_model_type": str(type(self.text_model)) if self.text_model else None,
            "text_model_repr": repr(self.text_model) if self.text_model else None,
            "init_error": self.init_error
        }, "B", "initial")
        # #endregion
        if not self.text_model:
            if self.init_error:
                return f'修改失敗: {self.init_error}'
            error_msg = '修改失敗: Gemini 文本模型未初始化。'
            error_msg += '\n請檢查 config.json 中的 gemini_api_key 是否正確配置。'
            error_msg += '\n支持的模型: gemini-1.5-flash, gemini-1.5-pro'
            return error_msg
        
        try:
            prompt = f"""
            請幫我修改以下文案，使其：
            1. 保持原意和風格
            2. 避免重複和抄襲
            3. 更加生動有趣
            4. 適合TikTok平台
            
            原文案：
            {original_script}
            
            風格要求：{style if style else '保持原風格'}
            
            請只返回修改後的文案，不要其他說明。
            """
            
            # #region agent log
            debug_log("GeminiAnalyzer.modify_script", "準備調用generate_content", {
                "model_name": self.text_model_name,
                "model_type": str(type(self.text_model)),
                "model_repr": repr(self.text_model),
                "prompt_length": len(prompt)
            }, "A", "initial")
            # #endregion
            response = self.text_model.generate_content(prompt)
            # #region agent log
            debug_log("GeminiAnalyzer.modify_script", "generate_content調用成功", {"response_length": len(response.text) if response.text else 0}, "A", "initial")
            # #endregion
            return response.text.strip()
        except Exception as e:
            # #region agent log
            debug_log("GeminiAnalyzer.modify_script", "generate_content調用失敗", {
                "error": str(e),
                "error_type": str(type(e).__name__),
                "text_model_type": str(type(self.text_model)) if self.text_model else None,
                "text_model_repr": repr(self.text_model) if self.text_model else None
            }, "A", "initial")
            # #endregion
            error_detail = str(e)
            if '404' in error_detail or 'not found' in error_detail.lower():
                return f'修改失敗: Gemini 模型不存在或已棄用。\n錯誤詳情: {error_detail}\n請檢查 API Key 是否有效，或更新到最新版本的 google-generativeai 包。'
            return f'修改失敗: {error_detail}'

# 數字人模塊
class DigitalHuman:
    def __init__(self):
        self.template_path = None
        self.output_dir = None
        self.advanced = None  # AdvancedDigitalHuman 實例
        self.use_wav2lip = False
        self.use_coqui_tts = False
        self.reference_voice_path = None
        
        # 嘗試導入高級功能
        try:
            from digital_human_advanced import AdvancedDigitalHuman
            self.advanced = AdvancedDigitalHuman()
        except ImportError:
            pass
    
    def set_template(self, template_path: str):
        """設置數字人模板"""
        self.template_path = template_path
    
    def set_output_dir(self, output_dir: str):
        """設置輸出目錄"""
        self.output_dir = output_dir
    
    def text_to_speech(self, text: str, output_audio_path: str, language: str = 'zh-tw') -> bool:
        """文字轉語音（TTS）"""
        try:
            # 方法1: 嘗試使用 gTTS（需要網絡）
            try:
                from gtts import gTTS
                import io
                tts = gTTS(text=text, lang=language, slow=False)
                tts.save(output_audio_path)
                return True
            except ImportError:
                pass
            except Exception as e:
                print(f"gTTS 失敗: {e}，嘗試其他方法...")
            
            # 方法2: 嘗試使用 pyttsx3（離線，但聲音質量較差）
            try:
                import pyttsx3
                engine = pyttsx3.init()
                # 設置語速和音量
                engine.setProperty('rate', 150)
                engine.setProperty('volume', 0.9)
                # 嘗試設置中文語音
                voices = engine.getProperty('voices')
                for voice in voices:
                    if 'chinese' in voice.name.lower() or 'zh' in voice.id.lower():
                        engine.setProperty('voice', voice.id)
                        break
                engine.save_to_file(text, output_audio_path)
                engine.runAndWait()
                return os.path.exists(output_audio_path)
            except ImportError:
                pass
            except Exception as e:
                print(f"pyttsx3 失敗: {e}")
            
            # 如果都失敗，返回 False
            print("警告: 未找到可用的 TTS 庫。請安裝 gTTS (pip install gtts) 或 pyttsx3 (pip install pyttsx3)")
            return False
        except Exception as e:
            print(f"TTS 失敗: {e}")
            return False
    
    def sync_lip_basic(self, video_path: str, audio_path: str, output_path: str) -> bool:
        """基本口型同步（使用 moviepy 合成視頻和音頻）"""
        try:
            if not MOVIEPY_AVAILABLE:
                print("警告: moviepy 未安裝，無法進行視頻合成")
                return False
            
            from moviepy import VideoFileClip, AudioFileClip
            
            # 加載視頻和音頻
            video = VideoFileClip(video_path)
            audio = AudioFileClip(audio_path)
            
            # 調整視頻長度以匹配音頻
            if video.duration < audio.duration:
                # 如果視頻較短，循環播放視頻
                loops = int(audio.duration / video.duration) + 1
                video = video.loop(duration=audio.duration)
            elif video.duration > audio.duration:
                # 如果視頻較長，截取到音頻長度
                video = video.subclip(0, audio.duration)
            
            # 合成視頻和音頻
            final_video = video.set_audio(audio)
            
            # 輸出視頻
            final_video.write_videofile(
                output_path,
                codec='libx264',
                audio_codec='aac',
                temp_audiofile='temp-audio.m4a',
                remove_temp=True,
                verbose=False,
                logger=None
            )
            
            # 清理資源
            video.close()
            audio.close()
            final_video.close()
            
            return os.path.exists(output_path)
        except Exception as e:
            print(f"基本口型同步失敗: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    def set_wav2lip_config(self, wav2lip_path: str, checkpoint_path: str = None):
        """設置Wav2Lip配置"""
        if self.advanced:
            self.advanced.set_wav2lip_path(wav2lip_path, checkpoint_path)
            self.use_wav2lip = True
    
    def set_reference_voice(self, voice_path: str):
        """設置參考語音路徑（用於語音克隆）"""
        self.reference_voice_path = voice_path
        self.use_coqui_tts = True
    
    def sync_lip(self, video_path: str, audio_path: str, output_path: str):
        """口型同步（優先使用Wav2Lip，否則使用基本方法）"""
        # 如果配置了Wav2Lip，優先使用
        if self.use_wav2lip and self.advanced:
            success, msg = self.advanced.sync_lip_wav2lip(video_path, audio_path, output_path)
            if success:
                print(f"✓ {msg}")
                return True
            else:
                print(f"⚠ Wav2Lip失敗: {msg}，回退到基本方法")
        
        # 回退到基本方法
        if self.sync_lip_basic(video_path, audio_path, output_path):
            return True
        
        return False
    
    def clone_voice(self, text: str, reference_voice_path: str, output_path: str) -> bool:
        """語音克隆（優先使用Coqui TTS，否則使用基本TTS）"""
        # 如果配置了Coqui TTS且有參考語音，優先使用
        if self.use_coqui_tts and self.advanced and reference_voice_path and os.path.exists(reference_voice_path):
            success, msg = self.advanced.clone_voice_coqui(text, reference_voice_path, output_path, language='zh')
            if success:
                print(f"✓ {msg}")
                return True
            else:
                print(f"⚠ Coqui TTS語音克隆失敗: {msg}，回退到基本TTS")
        
        # 如果只有Coqui TTS但沒有參考語音，使用簡單TTS
        if self.use_coqui_tts and self.advanced:
            success, msg = self.advanced.clone_voice_coqui_simple(text, output_path, language='zh')
            if success:
                print(f"✓ {msg}")
                return True
            else:
                print(f"⚠ Coqui TTS簡單TTS失敗: {msg}，回退到基本TTS")
        
        # 回退到基本TTS
        return self.text_to_speech(text, output_path)
    
    def generate_video(self, template_path: str, script: str, output_path: str, 
                      reference_voice_path: str = None) -> bool:
        """生成數字人視頻的完整流程"""
        try:
            if not os.path.exists(template_path):
                print(f"錯誤: 模板文件不存在: {template_path}")
                return False
            
            # 步驟1: 從文案生成語音
            temp_audio = os.path.join(os.path.dirname(output_path), 'temp_audio.mp3')
            # 優先使用參考語音進行克隆
            voice_to_use = reference_voice_path or self.reference_voice_path
            if voice_to_use and os.path.exists(voice_to_use):
                # 如果有參考語音，嘗試語音克隆
                if not self.clone_voice(script, voice_to_use, temp_audio):
                    # 如果克隆失敗，使用基本 TTS
                    if not self.text_to_speech(script, temp_audio):
                        return False
            else:
                # 使用基本 TTS
                if not self.text_to_speech(script, temp_audio):
                    return False
            
            if not os.path.exists(temp_audio):
                print("錯誤: 語音生成失敗")
                return False
            
            # 步驟2: 合成視頻和音頻（基本口型同步）
            if not self.sync_lip(template_path, temp_audio, output_path):
                print("錯誤: 視頻合成失敗")
                return False
            
            # 步驟3: 清理臨時文件
            try:
                if os.path.exists(temp_audio):
                    os.remove(temp_audio)
            except Exception:
                pass
            
            return True
        except Exception as e:
            print(f"生成數字人視頻失敗: {e}")
            import traceback
            traceback.print_exc()
            return False

# 主應用GUI
class TikTokAnalyzerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("TikTok 對標帳號分析與數字人應用")
        self.root.geometry("1200x800")
        
        self.config = Config()
        self.fetcher = TikTokFetcher()
        
        # 從utils獲取API key
        from utils import get_gemini_api_key
        api_key = get_gemini_api_key()
        self.analyzer = GeminiAnalyzer(api_key)
        self.digital_human = DigitalHuman()
        
        self.current_videos = []
        self.selected_video = None
        self.downloaded_videos = {}  # 存儲已下載的視頻路徑
        self.downloading_video_ids = set()  # 正在下載中的視頻 ID，預覽時會檢查
        self.video_items = {}        # Treeview item_id -> 視頻資料映射（保留兼容）
        self.video_list_items = []   # 視頻列表項目的 Frame 列表
        self.thumbnail_cache = {}    # 縮略圖緩存
        self.displayed_video_count = 10   # 先顯示的視頻數量，點「加載更多」逐次增加
        self._thumbnail_semaphore = threading.Semaphore(5)  # 同時最多 5 個縮略圖下載
        
        self.setup_ui()
    
    def setup_ui(self):
        # 主框架
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # 左側面板：帳號輸入和視頻列表
        left_panel = ttk.Frame(main_frame)
        left_panel.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), padx=(0, 10))
        
        # 帳號輸入區域
        account_frame = ttk.LabelFrame(left_panel, text="對標帳號", padding="10")
        account_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(account_frame, text="TikTok 用戶名:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.username_entry = ttk.Entry(account_frame, width=30)
        self.username_entry.grid(row=0, column=1, pady=5, padx=5)
        
        self.fetch_btn = ttk.Button(account_frame, text="獲取視頻", command=self.fetch_videos)
        self.fetch_btn.grid(row=0, column=2, pady=5, padx=5)
        
        # 排序選項
        sort_frame = ttk.LabelFrame(left_panel, text="排序方式", padding="10")
        sort_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.sort_var = tk.StringVar(value="最新")
        ttk.Radiobutton(sort_frame, text="最新", variable=self.sort_var, value="最新", 
                       command=self.sort_videos).pack(anchor=tk.W)
        ttk.Radiobutton(sort_frame, text="最多點讚", variable=self.sort_var, value="最多點讚",
                       command=self.sort_videos).pack(anchor=tk.W)
        ttk.Radiobutton(sort_frame, text="最多收藏", variable=self.sort_var, value="最多收藏",
                       command=self.sort_videos).pack(anchor=tk.W)
        ttk.Radiobutton(sort_frame, text="最多分享", variable=self.sort_var, value="最多分享",
                       command=self.sort_videos).pack(anchor=tk.W)
        
        # 視頻詳細信息顯示區域
        self.video_info_frame = ttk.LabelFrame(left_panel, text="視頻詳細信息", padding="10")
        self.video_info_frame.pack(fill=tk.X, pady=(0, 10))
        
        self.video_info_text = tk.Text(self.video_info_frame, height=6, wrap=tk.WORD, state=tk.DISABLED)
        self.video_info_text.pack(fill=tk.X)
        
        # 視頻預覽按鈕
        preview_btn_frame = ttk.Frame(self.video_info_frame)
        preview_btn_frame.pack(fill=tk.X, pady=(5, 0))
        self.preview_btn = ttk.Button(preview_btn_frame, text="預覽視頻", command=self.preview_video, state=tk.DISABLED)
        self.preview_btn.pack(side=tk.LEFT, padx=5)
        self.download_btn = ttk.Button(preview_btn_frame, text="下載視頻", command=self.download_selected_video, state=tk.DISABLED)
        self.download_btn.pack(side=tk.LEFT, padx=5)
        
        # 視頻列表（帶縮略圖）
        list_frame = ttk.LabelFrame(left_panel, text="視頻列表", padding="10")
        list_frame.pack(fill=tk.BOTH, expand=True)
        
        # 創建 Canvas 和 Scrollbar 用於滾動
        canvas = tk.Canvas(list_frame, bg='white')
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=canvas.yview)
        self.video_list_container = ttk.Frame(canvas)
        
        canvas.create_window((0, 0), window=self.video_list_container, anchor='nw')
        canvas.configure(yscrollcommand=scrollbar.set)
        
        def on_frame_configure(event):
            canvas.configure(scrollregion=canvas.bbox('all'))
        
        self.video_list_container.bind('<Configure>', on_frame_configure)
        
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # 存儲視頻項目引用
        self.video_list_items = []
        # 「加載更多」按鈕容器（稍後在 update_video_list 中創建）
        self.load_more_btn = None
        self.load_more_frame = None
        
        # 右側面板：分析和編輯
        right_panel = ttk.Frame(main_frame)
        right_panel.grid(row=0, column=1, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # 視頻分析區域
        analysis_frame = ttk.LabelFrame(right_panel, text="視頻分析", padding="10")
        analysis_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))
        
        self.analyze_btn = ttk.Button(analysis_frame, text="分析視頻", command=self.analyze_selected_video)
        self.analyze_btn.pack(pady=5)

        # 測試：僅用標題做 AI 文案
        self.test_ai_btn = ttk.Button(analysis_frame, text="測試標題AI文案", command=self.test_title_ai)
        self.test_ai_btn.pack(pady=5)
        
        ttk.Label(analysis_frame, text="提取的文案:").pack(anchor=tk.W, pady=(10, 5))
        self.script_text = scrolledtext.ScrolledText(analysis_frame, height=8, width=50)
        self.script_text.pack(fill=tk.BOTH, expand=True, pady=5)
        
        btn_frame = ttk.Frame(analysis_frame)
        btn_frame.pack(fill=tk.X, pady=5)
        
        self.copy_btn = ttk.Button(btn_frame, text="複製文案", command=self.copy_script)
        self.copy_btn.pack(side=tk.LEFT, padx=5)
        
        self.modify_btn = ttk.Button(btn_frame, text="AI修改", command=self.modify_script)
        self.modify_btn.pack(side=tk.LEFT, padx=5)
        
        # 數字人區域
        digital_frame = ttk.LabelFrame(right_panel, text="數字人設置", padding="10")
        digital_frame.pack(fill=tk.X)
        
        # 模板選擇
        ttk.Label(digital_frame, text="模板路徑:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.template_entry = ttk.Entry(digital_frame, width=40)
        self.template_entry.grid(row=0, column=1, pady=5, padx=5)
        ttk.Button(digital_frame, text="選擇模板", command=self.select_template).grid(row=0, column=2, pady=5)
        
        # 參考語音（用於語音克隆）
        ttk.Label(digital_frame, text="參考語音:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.reference_voice_entry = ttk.Entry(digital_frame, width=40)
        self.reference_voice_entry.grid(row=1, column=1, pady=5, padx=5)
        ttk.Button(digital_frame, text="選擇語音", command=self.select_reference_voice).grid(row=1, column=2, pady=5)
        
        # 高級設置按鈕
        ttk.Button(digital_frame, text="高級設置 (Wav2Lip)", command=self.open_advanced_settings).grid(row=2, column=0, columnspan=3, pady=5)
        
        # 生成按鈕
        ttk.Button(digital_frame, text="生成數字人視頻", command=self.generate_digital_video).grid(row=3, column=0, columnspan=3, pady=10)
        
        # 狀態欄
        self.status_label = ttk.Label(main_frame, text="就緒", relief=tk.SUNKEN)
        self.status_label.grid(row=1, column=0, columnspan=2, sticky=(tk.W, tk.E))
        
        # 配置網格權重
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)
        main_frame.rowconfigure(0, weight=1)
        left_panel.rowconfigure(2, weight=1)

    def test_title_ai(self):
        """只用當前選中視頻的標題測試 Gemini 文案"""
        if not self.selected_video:
            messagebox.showwarning("警告", "請先在左側列表選擇一個視頻")
            return

        # 簡單顯示提示狀態
        self.status_label.config(text="正在使用標題測試 AI 文案...")

        def run():
            try:
                # 直接呼叫分析器的 metadata 分析（不讀取影片檔）
                result = self.analyzer._analyze_from_metadata(self.selected_video)
                if not result:
                    result = self._fallback_video_info()

                if not result:
                    self.root.after(0, lambda: self.show_error_dialog("測試提示", "無法生成文案，請確認 Gemini API Key 是否有效"))
                    self.root.after(0, lambda: self.status_label.config(text="測試失敗"))
                    return

                self.root.after(0, lambda: self._display_analysis_result(result))
                self.root.after(0, lambda: self.status_label.config(text="標題AI文案測試完成"))
            except Exception as e:
                import traceback
                err = f"{str(e)}\n\n{traceback.format_exc()}"
                self.root.after(0, lambda: self.show_error_dialog("測試失敗", err))
                self.root.after(0, lambda: self.status_label.config(text="測試失敗"))

        threading.Thread(target=run, daemon=True).start()
    
    def fetch_videos(self):
        """獲取用戶視頻"""
        username = self.username_entry.get().strip()
        if not username:
            messagebox.showerror("錯誤", "請輸入TikTok用戶名")
            return
        
        def run():
            self.status_label.config(text=f"正在獲取 @{username} 的視頻...")
            try:
                videos = self.fetcher.fetch_user_videos(username)
                if videos:
                    self.current_videos = videos
                    self.displayed_video_count = 10  # 新用戶先只顯示 10 個
                    self.root.after(0, self.update_video_list)
                    self.root.after(0, lambda: self.status_label.config(text=f"成功獲取 {len(videos)} 個視頻（已顯示 10 個，可點「加載更多」）"))
                else:
                    self.root.after(0, lambda: messagebox.showwarning("警告", "未找到視頻，請檢查用戶名是否正確"))
            except Exception as e:
                self.root.after(0, lambda: messagebox.showerror("錯誤", f"獲取視頻失敗: {str(e)}"))
        
        threading.Thread(target=run, daemon=True).start()
    
    def update_video_list(self):
        """更新視頻列表（帶縮略圖）；先顯示前 N 個，可點「加載更多」逐次增加"""
        # 清空現有項目（含加載更多按鈕）
        for widget in self.video_list_container.winfo_children():
            widget.destroy()
        self.video_list_items.clear()
        self.video_items.clear()
        self.load_more_frame = None
        self.load_more_btn = None
        
        # 檢查已下載的視頻
        if os.path.exists(self.config.videos_dir):
            for filename in os.listdir(self.config.videos_dir):
                if filename.endswith(('.mp4', '.webm', '.mkv')):
                    video_id = os.path.splitext(filename)[0]
                    video_path = os.path.join(self.config.videos_dir, filename)
                    self.downloaded_videos[video_id] = video_path
        
        # 只顯示前 displayed_video_count 個
        to_show = self.current_videos[:self.displayed_video_count]
        for idx, video in enumerate(to_show):
            self._create_video_item(video, idx)
        
        # 若還有未顯示的，加上「加載更多」按鈕
        total = len(self.current_videos)
        if total > self.displayed_video_count:
            self.load_more_frame = ttk.Frame(self.video_list_container)
            self.load_more_frame.pack(fill=tk.X, padx=2, pady=8)
            remaining = total - self.displayed_video_count
            next_batch = min(10, remaining)
            self.load_more_btn = ttk.Button(
                self.load_more_frame,
                text=f"加載更多（再顯示 {next_batch} 個，共 {total} 個）",
                command=self._load_more_videos
            )
            self.load_more_btn.pack()
    
    def _create_video_item(self, video: Dict, index: int):
        """創建單個視頻列表項（帶縮略圖）"""
        video_id = video.get('id', '')
        is_downloaded = video_id in self.downloaded_videos
        
        # 創建視頻項目的 Frame
        item_frame = ttk.Frame(self.video_list_container, relief=tk.RAISED, borderwidth=1)
        item_frame.pack(fill=tk.X, padx=2, pady=2)
        item_frame.bind('<Button-1>', lambda e, v=video: self.on_video_item_click(v))
        
        # 縮略圖區域
        thumb_frame = ttk.Frame(item_frame)
        thumb_frame.pack(side=tk.LEFT, padx=5, pady=5)
        
        # 縮略圖標籤（將在後台加載）
        thumb_label = ttk.Label(thumb_frame, text="載入中...", width=12)
        thumb_label.pack()
        
        # 視頻信息區域
        info_frame = ttk.Frame(item_frame)
        info_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        
        # 標題
        title_text = video.get('title', '無標題')[:40]
        title_label = ttk.Label(info_frame, text=title_text, font=('Arial', 9, 'bold'), cursor='hand2')
        title_label.pack(anchor=tk.W)
        title_label.bind('<Button-1>', lambda e, v=video: self.on_video_item_click(v))
        
        # 統計信息
        stats_text = f"播放: {video.get('view_count', 0):,} | "
        stats_text += f"點讚: {video.get('like_count', 0):,} | "
        stats_text += f"時長: {video.get('duration', 0)}s"
        if is_downloaded:
            stats_text += " | ✓已下載"
        
        stats_label = ttk.Label(info_frame, text=stats_text, font=('Arial', 8), cursor='hand2')
        stats_label.pack(anchor=tk.W)
        stats_label.bind('<Button-1>', lambda e, v=video: self.on_video_item_click(v))
        
        # 日期
        date_text = f"發布: {video.get('upload_date', 'N/A')}"
        date_label = ttk.Label(info_frame, text=date_text, font=('Arial', 7), cursor='hand2')
        date_label.pack(anchor=tk.W)
        date_label.bind('<Button-1>', lambda e, v=video: self.on_video_item_click(v))
        
        # 存儲引用
        item_data = {
            'frame': item_frame,
            'thumb_label': thumb_label,
            'video': video
        }
        self.video_list_items.append(item_data)
        self.video_items[id(item_frame)] = video
        
        # 後台加載縮略圖（受並發數限制）
        self._load_thumbnail(video, thumb_label)
    
    def _load_more_videos(self):
        """點擊「加載更多」時多顯示 10 個視頻"""
        self.displayed_video_count = min(
            self.displayed_video_count + 10,
            len(self.current_videos)
        )
        self.update_video_list()
        self.status_label.config(text=f"已顯示 {self.displayed_video_count} / {len(self.current_videos)} 個視頻")
    
    def _load_thumbnail(self, video: Dict, thumb_label: ttk.Label):
        """後台加載視頻縮略圖（同時最多 5 個下載，避免卡頓）"""
        def load():
            self._thumbnail_semaphore.acquire()
            try:
                video_id = video.get('id', '')
                thumbnail_url = video.get('thumbnail', '')
                
                # 檢查緩存
                if video_id in self.thumbnail_cache:
                    img = self.thumbnail_cache[video_id]
                    def set_image(img=img):
                        thumb_label.config(image=img, text='')
                        thumb_label.image = img
                    self.root.after(0, set_image)
                    return
                
                # 方法1: 如果視頻已下載，從視頻文件提取縮略圖
                video_path = self._find_downloaded_file(video_id) or self.downloaded_videos.get(video_id)
                if video_path and os.path.exists(video_path) and CV2_AVAILABLE:
                    try:
                        import cv2
                        cap = cv2.VideoCapture(video_path)
                        ret, frame = cap.read()
                        cap.release()
                        if ret:
                            # 轉換BGR到RGB
                            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                            img = Image.fromarray(frame_rgb)
                            img.thumbnail((120, 160), Image.Resampling.LANCZOS)
                            photo = ImageTk.PhotoImage(img)
                            self.thumbnail_cache[video_id] = photo
                            def set_image(photo=photo):
                                thumb_label.config(image=photo, text='')
                                thumb_label.image = photo
                            self.root.after(0, set_image)
                            return
                    except Exception as e:
                        print(f"從視頻提取縮略圖失敗: {e}")
                
                # 方法2: 從URL下載縮略圖
                if thumbnail_url:
                    try:
                        headers = {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                        response = requests.get(thumbnail_url, timeout=10, headers=headers)
                        if response.status_code == 200:
                            img_data = BytesIO(response.content)
                            img = Image.open(img_data)
                            img.thumbnail((120, 160), Image.Resampling.LANCZOS)
                            photo = ImageTk.PhotoImage(img)
                            
                            # 緩存
                            self.thumbnail_cache[video_id] = photo
                            
                            # 更新 UI
                            def set_image(photo=photo):
                                thumb_label.config(image=photo, text='')
                                thumb_label.image = photo
                            self.root.after(0, set_image)
                            return
                    except Exception as e:
                        print(f"下載縮略圖失敗: {e}")
                
                # 方法3: 嘗試從視頻URL構建縮略圖URL
                video_url = video.get('url', '')
                if video_url and not thumbnail_url:
                    # TikTok縮略圖通常可以從視頻URL推斷，但這不總是可靠
                    # 這裡我們只顯示"無縮略圖"
                    pass
                
                # 如果所有方法都失敗，顯示"無縮略圖"
                self.root.after(0, lambda: thumb_label.config(text="無縮略圖", width=12))
            except Exception as e:
                print(f"加載縮略圖時出錯: {e}")
                self.root.after(0, lambda: thumb_label.config(text="載入失敗", width=12))
            finally:
                self._thumbnail_semaphore.release()
        
        threading.Thread(target=load, daemon=True).start()
    
    def on_video_item_click(self, video: Dict):
        """點擊視頻項目時"""
        self.selected_video = video
        self.update_video_info()
        
        # 高亮選中的項目
        for item_data in self.video_list_items:
            if item_data['video'] == video:
                item_data['frame'].config(relief=tk.SOLID, borderwidth=2)
            else:
                item_data['frame'].config(relief=tk.RAISED, borderwidth=1)
        
        self.status_label.config(text=f"已選擇視頻: {video.get('title', '無標題')}")
    
    def sort_videos(self):
        """排序視頻"""
        if not self.current_videos:
            return
        
        sort_type = self.sort_var.get()
        
        if sort_type == "最新":
            self.current_videos.sort(key=lambda x: x.get('upload_date', ''), reverse=True)
        elif sort_type == "最多點讚":
            self.current_videos.sort(key=lambda x: x.get('like_count', 0), reverse=True)
        elif sort_type == "最多收藏":
            # 如果沒有收藏數據，使用點讚數
            self.current_videos.sort(key=lambda x: x.get('favorite_count', x.get('like_count', 0)), reverse=True)
        elif sort_type == "最多分享":
            self.current_videos.sort(key=lambda x: x.get('share_count', 0), reverse=True)
        
        self.update_video_list()
    
    def on_video_select(self, event):
        """選擇視頻時（Treeview 兼容方法，已改用 on_video_item_click）"""
        # 保留此方法以兼容舊代碼，但主要使用 on_video_item_click
        pass
    
    def update_video_info(self):
        """更新視頻詳細信息顯示"""
        if not self.selected_video:
            return
        
        self.video_info_text.config(state=tk.NORMAL)
        self.video_info_text.delete(1.0, tk.END)
        
        info = f"標題: {self.selected_video.get('title', '無標題')}\n"
        info += f"視頻ID: {self.selected_video.get('id', 'N/A')}\n"
        info += f"點讚數: {self.selected_video.get('like_count', 0):,}\n"
        info += f"觀看數: {self.selected_video.get('view_count', 0):,}\n"
        info += f"評論數: {self.selected_video.get('comment_count', 0):,}\n"
        info += f"分享數: {self.selected_video.get('share_count', 0):,}\n"
        info += f"時長: {self.selected_video.get('duration', 0)}秒\n"
        info += f"發布日期: {self.selected_video.get('upload_date', 'N/A')}\n"
        
        self.video_info_text.insert(1.0, info)
        self.video_info_text.config(state=tk.DISABLED)
        
        # 啟用按鈕（預覽按鈕依是否已下載／下載中更新狀態）
        self._update_preview_button_state()
        self.download_btn.config(state=tk.NORMAL)
    
    def _find_downloaded_file(self, video_id: str) -> Optional[str]:
        """查找已下載的視頻文件（支持 mp4、webm 等格式）"""
        base = os.path.join(self.config.videos_dir, video_id)
        for ext in ['.mp4', '.webm', '.mkv', '.m4a']:
            path = base + ext
            if os.path.exists(path):
                return path
        # 檢查目錄內是否有包含 video_id 的文件
        if os.path.exists(self.config.videos_dir):
            for fn in os.listdir(self.config.videos_dir):
                if video_id in fn and fn.endswith(('.mp4', '.webm', '.mkv')):
                    return os.path.join(self.config.videos_dir, fn)
        return None
    
    def download_selected_video(self):
        """下載選中的視頻"""
        if not self.selected_video:
            messagebox.showwarning("警告", "請先選擇一個視頻")
            return
        
        video_id = self.selected_video.get('id', '')
        if video_id in self.downloading_video_ids:
            messagebox.showinfo("提示", "該視頻正在下載中，請稍候完成後再操作。")
            return
        
        def run():
            self.downloading_video_ids.add(video_id)
            self.root.after(0, self._update_preview_button_state)
            self.root.after(0, lambda: self.status_label.config(text="正在下載視頻..."))
            try:
                username = self.username_entry.get().strip()
                # 一律使用 tiktok.com 頁面 URL，避免 403 與 generic 提取器
                video_url = f"https://www.tiktok.com/@{username}/video/{video_id}" if username else f"https://www.tiktok.com/video/{video_id}"
                
                existing = self._find_downloaded_file(video_id)
                if existing:
                    self.downloaded_videos[video_id] = existing
                    self.root.after(0, lambda: messagebox.showinfo("成功", f"視頻已存在: {existing}"))
                    self.root.after(0, lambda: self.status_label.config(text="視頻已存在"))
                    return
                
                out_template = os.path.join(self.config.videos_dir, f"{video_id}.%(ext)s")
                ydl_opts = {
                    **get_tiktok_ydl_base_opts(),
                    'outtmpl': out_template,
                    'format': 'best[ext=mp4]/best',
                    'quiet': False,
                    'no_warnings': False,
                }
                
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([video_url])
                
                result_path = self._find_downloaded_file(video_id)
                if result_path:
                    self.downloaded_videos[video_id] = result_path
                    self.root.after(0, lambda: messagebox.showinfo("成功", f"視頻已下載: {result_path}"))
                    self.root.after(0, lambda: self.status_label.config(text="下載完成"))
                else:
                    self.root.after(0, lambda: self.show_error_dialog("下載失敗", "無法找到下載後的視頻檔案"))
            except Exception as e:
                import traceback
                err_msg = f"下載失敗: {str(e)}\n\n{traceback.format_exc()}"
                self.root.after(0, lambda: self.show_error_dialog("下載失敗", err_msg))
                self.root.after(0, lambda: self.status_label.config(text="下載失敗"))
            finally:
                self.downloading_video_ids.discard(video_id)
                self.root.after(0, self._update_preview_button_state)
        
        threading.Thread(target=run, daemon=True).start()
    
    def _update_preview_button_state(self):
        """根據當前選中視頻是否已下載／是否下載中，更新預覽按鈕狀態"""
        if not self.preview_btn.winfo_exists():
            return
        if not self.selected_video:
            self.preview_btn.config(state=tk.DISABLED, text="預覽視頻")
            return
        video_id = self.selected_video.get('id', '')
        if video_id in self.downloading_video_ids:
            self.preview_btn.config(state=tk.DISABLED, text="下載中...")
            return
        video_path = self._find_downloaded_file(video_id) or self.downloaded_videos.get(video_id)
        if video_path and os.path.exists(video_path):
            self.preview_btn.config(state=tk.NORMAL, text="預覽視頻")
        else:
            self.preview_btn.config(state=tk.NORMAL, text="預覽視頻（未下載則先下載）")
    
    def preview_video(self):
        """預覽視頻"""
        if not self.selected_video:
            messagebox.showwarning("警告", "請先選擇一個視頻")
            return
        
        video_id = self.selected_video.get('id', '')
        if video_id in self.downloading_video_ids:
            messagebox.showinfo("提示", "該視頻正在下載中，請稍候完成後再預覽。")
            return
        
        video_path = self._find_downloaded_file(video_id) or self.downloaded_videos.get(video_id)
        
        if not video_path or not os.path.exists(video_path):
            # 如果沒有下載，先下載再預覽
            response = messagebox.askyesno("提示", "視頻尚未下載，是否現在下載？下載完成後將自動預覽。")
            if response:
                def do_download_then_preview():
                    import time
                    self.downloading_video_ids.add(video_id)
                    self.root.after(0, self._update_preview_button_state)
                    self.root.after(0, lambda: self.status_label.config(text="正在下載視頻..."))
                    username = self.username_entry.get().strip()
                    video_url = f"https://www.tiktok.com/@{username}/video/{video_id}" if username else f"https://www.tiktok.com/video/{video_id}"
                    
                    out_template = os.path.join(self.config.videos_dir, f"{video_id}.%(ext)s")
                    ydl_opts = {
                        **get_tiktok_ydl_base_opts(),
                        'outtmpl': out_template,
                        'format': 'best[ext=mp4]/best',
                    }
                    try:
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            ydl.download([video_url])
                        
                        for _ in range(10):
                            time.sleep(1)
                            path = self._find_downloaded_file(video_id)
                            if path:
                                self.downloaded_videos[video_id] = path
                                self.downloading_video_ids.discard(video_id)
                                self.root.after(0, self._update_preview_button_state)
                                self.root.after(0, lambda: self._open_video(path))
                                self.root.after(0, lambda: self.status_label.config(text="預覽已打開"))
                                return
                        self.downloading_video_ids.discard(video_id)
                        self.root.after(0, self._update_preview_button_state)
                        self.root.after(0, lambda: self.show_error_dialog("預覽失敗", "下載完成但無法找到視頻文件"))
                    except Exception as e:
                        import traceback
                        self.downloading_video_ids.discard(video_id)
                        self.root.after(0, self._update_preview_button_state)
                        err_msg = f"下載失敗: {str(e)}\n\n{traceback.format_exc()}"
                        self.root.after(0, lambda: self.show_error_dialog("預覽下載失敗", err_msg))
                
                threading.Thread(target=do_download_then_preview, daemon=True).start()
            return
        
        self._open_video(video_path)
    
    def _open_video(self, video_path: str):
        """使用系統默認播放器打開視頻"""
        try:
            import subprocess
            import platform
            
            video_path = os.path.abspath(video_path)
            if not os.path.exists(video_path):
                self.show_error_dialog("錯誤", f"視頻文件不存在: {video_path}")
                return
            
            if platform.system() == 'Windows':
                os.startfile(video_path)
            elif platform.system() == 'Darwin':  # macOS
                subprocess.run(['open', video_path], check=True)
            else:  # Linux
                subprocess.run(['xdg-open', video_path], check=True)
            
            self.status_label.config(text=f"正在預覽: {os.path.basename(video_path)}")
        except Exception as e:
            import traceback
            err_msg = f"無法打開視頻: {str(e)}\n\n路徑: {video_path}\n\n{traceback.format_exc()}"
            self.show_error_dialog("預覽失敗", err_msg)
    
    def show_error_dialog(self, title: str, message: str):
        """顯示可複製的錯誤訊息對話框"""
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry("720x420")
        
        txt = scrolledtext.ScrolledText(win, wrap=tk.WORD)
        txt.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        txt.insert("1.0", message)
        txt.configure(state=tk.DISABLED)
        
        btn_frame = ttk.Frame(win)
        btn_frame.pack(fill=tk.X, padx=10, pady=(0, 10))
        
        def copy_all():
            self.root.clipboard_clear()
            self.root.clipboard_append(message)
        
        ttk.Button(btn_frame, text="複製錯誤內容", command=copy_all).pack(side=tk.LEFT)
        ttk.Button(btn_frame, text="關閉", command=win.destroy).pack(side=tk.RIGHT)
    
    def analyze_selected_video(self):
        """分析選中的視頻"""
        if not self.selected_video:
            messagebox.showwarning("警告", "請先選擇一個視頻")
            return
        
        def run():
            self.root.after(0, lambda: self.status_label.config(text="正在下載並分析視頻..."))
            try:
                video_id = self.selected_video.get('id', '')
                video_path = self._find_downloaded_file(video_id) or self.downloaded_videos.get(video_id)
                
                # 如果沒有下載，先下載
                if not video_path or not os.path.exists(video_path):
                    username = self.username_entry.get().strip()
                    video_url = f"https://www.tiktok.com/@{username}/video/{video_id}" if username else f"https://www.tiktok.com/video/{video_id}"
                    
                    self.root.after(0, lambda: self.status_label.config(text="正在下載視頻..."))
                    
                    out_template = os.path.join(self.config.videos_dir, f"{video_id}.%(ext)s")
                    ydl_opts = {
                        **get_tiktok_ydl_base_opts(),
                        'outtmpl': out_template,
                        'format': 'best[ext=mp4]/best',
                        'quiet': False,
                    }
                    
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([video_url])
                    
                    video_path = self._find_downloaded_file(video_id)
                    if not video_path:
                        self.root.after(0, lambda: messagebox.showerror("錯誤", "視頻下載失敗"))
                        return
                    self.downloaded_videos[video_id] = video_path
                
                # 分析視頻
                self.root.after(0, lambda: self.status_label.config(text="正在分析視頻..."))
                result = self.analyzer.analyze_video(video_path, self.selected_video)
                
                if 'error' in result:
                    self.root.after(0, lambda: self.show_error_dialog("分析提示", result.get('error', '未知錯誤')))
                    self.root.after(0, lambda: self.status_label.config(text=result.get('error', '分析失敗')))
                    # 即使出錯也顯示備用內容
                    fallback = self._fallback_video_info()
                    if fallback:
                        self.root.after(0, lambda: self._display_analysis_result(fallback))
                        return
                
                self.root.after(0, lambda: self._display_analysis_result(result))
                self.root.after(0, lambda: self.status_label.config(text="分析完成"))
            except Exception as e:
                import traceback
                err_detail = f"{str(e)}\n\n{traceback.format_exc()}"
                self.root.after(0, lambda: self.show_error_dialog("分析失敗", err_detail))
                self.root.after(0, lambda: self.status_label.config(text="分析失敗"))
                # 顯示備用信息
                fallback = self._fallback_video_info()
                if fallback:
                    self.root.after(0, lambda: self._display_analysis_result(fallback))
        
        threading.Thread(target=run, daemon=True).start()
    
    def _fallback_video_info(self):
        """無 Gemini 時的備用文案（使用已有元數據）"""
        if not self.selected_video:
            return None
        v = self.selected_video
        return {
            'title': v.get('title', '無標題'),
            'content': '請配置 Gemini API 或安裝 moviepy 以獲取 AI 分析',
            'style': '未知',
            'script': f"標題: {v.get('title', '')}\n\n可先複製此標題，或配置 config.json 中的 gemini_api_key 後再次分析。",
            'description': f"點讚: {v.get('like_count', 0):,} | 觀看: {v.get('view_count', 0):,} | 評論: {v.get('comment_count', 0):,}",
        }
    
    def _display_analysis_result(self, result: dict):
        """顯示分析結果到文案區域"""
        full_text = f"標題: {result.get('title', '')}\n\n"
        full_text += f"內容: {result.get('content', '')}\n\n"
        full_text += f"風格: {result.get('style', '')}\n\n"
        full_text += f"文案:\n{result.get('script', '')}\n\n"
        full_text += f"描述: {result.get('description', '')}"
        self.script_text.delete(1.0, tk.END)
        self.script_text.insert(1.0, full_text)
    
    def copy_script(self):
        """複製文案"""
        script = self.script_text.get(1.0, tk.END).strip()
        if script:
            self.root.clipboard_clear()
            self.root.clipboard_append(script)
            messagebox.showinfo("成功", "文案已複製到剪貼板")
        else:
            messagebox.showwarning("警告", "沒有可複製的文案")
    
    def modify_script(self):
        """AI修改文案"""
        original = self.script_text.get(1.0, tk.END).strip()
        if not original:
            messagebox.showwarning("警告", "請先分析視頻獲取文案")
            return
        
        def run():
            self.status_label.config(text="正在使用AI修改文案...")
            try:
                modified = self.analyzer.modify_script(original)
                self.root.after(0, lambda: self.script_text.delete(1.0, tk.END))
                self.root.after(0, lambda: self.script_text.insert(1.0, modified))
                self.root.after(0, lambda: self.status_label.config(text="文案修改完成"))
            except Exception as e:
                self.root.after(0, lambda: messagebox.showerror("錯誤", f"修改失敗: {str(e)}"))
        
        threading.Thread(target=run, daemon=True).start()
    
    def select_template(self):
        """選擇數字人模板"""
        template_path = filedialog.askopenfilename(
            title="選擇數字人模板",
            filetypes=[("視頻文件", "*.mp4 *.avi *.mov"), ("所有文件", "*.*")]
        )
        if template_path:
            self.template_entry.delete(0, tk.END)
            self.template_entry.insert(0, template_path)
            self.digital_human.set_template(template_path)
    
    def select_reference_voice(self):
        """選擇參考語音文件（用於語音克隆）"""
        voice_path = filedialog.askopenfilename(
            title="選擇參考語音文件",
            filetypes=[("音頻文件", "*.wav *.mp3 *.m4a"), ("所有文件", "*.*")]
        )
        if voice_path:
            self.reference_voice_entry.delete(0, tk.END)
            self.reference_voice_entry.insert(0, voice_path)
            self.digital_human.set_reference_voice(voice_path)
    
    def open_advanced_settings(self):
        """打開高級設置窗口（Wav2Lip配置）"""
        win = tk.Toplevel(self.root)
        win.title("高級設置 - Wav2Lip配置")
        win.geometry("700x450")
        
        main_frame = ttk.Frame(win, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # Wav2Lip路徑
        ttk.Label(main_frame, text="Wav2Lip 目錄路徑:").grid(row=0, column=0, sticky=tk.W, pady=10)
        wav2lip_entry = ttk.Entry(main_frame, width=50)
        wav2lip_entry.grid(row=0, column=1, pady=10, padx=5)
        
        def browse_wav2lip():
            path = filedialog.askdirectory(title="選擇Wav2Lip目錄")
            if path:
                wav2lip_entry.delete(0, tk.END)
                wav2lip_entry.insert(0, path)
        
        ttk.Button(main_frame, text="瀏覽", command=browse_wav2lip).grid(row=0, column=2, pady=10)
        
        # 檢查點路徑
        ttk.Label(main_frame, text="檢查點文件路徑:").grid(row=1, column=0, sticky=tk.W, pady=10)
        checkpoint_entry = ttk.Entry(main_frame, width=50)
        checkpoint_entry.grid(row=1, column=1, pady=10, padx=5)
        
        def browse_checkpoint():
            path = filedialog.askopenfilename(
                title="選擇Wav2Lip檢查點文件",
                filetypes=[("模型文件", "*.pth"), ("所有文件", "*.*")]
            )
            if path:
                checkpoint_entry.delete(0, tk.END)
                checkpoint_entry.insert(0, path)
        
        ttk.Button(main_frame, text="瀏覽", command=browse_checkpoint).grid(row=1, column=2, pady=10)
        
        # 狀態顯示
        status_label = ttk.Label(main_frame, text="", foreground="gray")
        status_label.grid(row=2, column=0, columnspan=3, pady=10)
        
        def check_config():
            """檢查配置是否正確"""
            wav2lip_path = wav2lip_entry.get().strip()
            checkpoint_path = checkpoint_entry.get().strip()
            
            if not wav2lip_path:
                status_label.config(text="請設置Wav2Lip路徑", foreground="red")
                return
            
            if not os.path.exists(wav2lip_path):
                status_label.config(text=f"錯誤: Wav2Lip路徑不存在", foreground="red")
                return
            
            inference_script = os.path.join(wav2lip_path, 'inference.py')
            if not os.path.exists(inference_script):
                status_label.config(text=f"錯誤: 找不到 inference.py", foreground="red")
                return
            
            if checkpoint_path and not os.path.exists(checkpoint_path):
                status_label.config(text=f"錯誤: 檢查點文件不存在", foreground="red")
                return
            
            status_label.config(text="✓ 配置檢查通過", foreground="green")
        
        ttk.Button(main_frame, text="檢查配置", command=check_config).grid(row=3, column=0, columnspan=3, pady=10)
        
        # 說明文字
        info_text = """
Wav2Lip安裝說明:
1. git clone https://github.com/Rudrabha/Wav2Lip.git
2. cd Wav2Lip
3. pip install -r requirements.txt
4. 下載檢查點: https://github.com/Rudrabha/Wav2Lip#pre-trained-models
   放置到 Wav2Lip/checkpoints/wav2lip_gan.pth
        """
        ttk.Label(main_frame, text=info_text, justify=tk.LEFT, foreground="gray").grid(row=4, column=0, columnspan=3, pady=10)
        
        def save_config():
            """保存配置"""
            wav2lip_path = wav2lip_entry.get().strip()
            checkpoint_path = checkpoint_entry.get().strip()
            
            if wav2lip_path:
                self.digital_human.set_wav2lip_config(wav2lip_path, checkpoint_path if checkpoint_path else None)
                messagebox.showinfo("成功", "Wav2Lip配置已保存")
                win.destroy()
            else:
                messagebox.showwarning("警告", "請設置Wav2Lip路徑")
        
        btn_frame = ttk.Frame(main_frame)
        btn_frame.grid(row=5, column=0, columnspan=3, pady=20)
        ttk.Button(btn_frame, text="保存", command=save_config).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="取消", command=win.destroy).pack(side=tk.LEFT, padx=5)
    
    def generate_digital_video(self):
        """生成數字人視頻"""
        if not self.selected_video:
            messagebox.showwarning("警告", "請先選擇一個視頻")
            return
        
        template_path = self.template_entry.get()
        if not template_path or not os.path.exists(template_path):
            messagebox.showwarning("警告", "請先選擇數字人模板")
            return
        
        script = self.script_text.get(1.0, tk.END).strip()
        if not script:
            messagebox.showwarning("警告", "請先獲取文案")
            return
        
        # 提取純文案文本（移除標題、內容等前綴）
        script_lines = script.split('\n')
        script_text = ''
        for line in script_lines:
            if line.startswith('標題:') or line.startswith('內容:') or line.startswith('風格:') or line.startswith('描述:'):
                continue
            if line.startswith('文案:'):
                script_text += line[3:].strip() + '\n'
            else:
                script_text += line.strip() + '\n'
        script_text = script_text.strip()
        
        if not script_text:
            messagebox.showwarning("警告", "無法從文案區域提取有效文本")
            return
        
        # 選擇輸出文件
        output_path = filedialog.asksaveasfilename(
            title="保存數字人視頻",
            defaultextension=".mp4",
            filetypes=[("視頻文件", "*.mp4"), ("所有文件", "*.*")]
        )
        
        if not output_path:
            return
        
        def run():
            self.root.after(0, lambda: self.status_label.config(text="正在生成數字人視頻..."))
            
            try:
                # 設置輸出目錄
                self.digital_human.set_output_dir(os.path.dirname(output_path))
                
                # 獲取參考語音路徑
                reference_voice = self.reference_voice_entry.get().strip()
                reference_voice_path = reference_voice if reference_voice and os.path.exists(reference_voice) else None
                
                # 生成視頻
                success = self.digital_human.generate_video(
                    template_path=template_path,
                    script=script_text,
                    output_path=output_path,
                    reference_voice_path=reference_voice_path
                )
                
                if success:
                    # 顯示使用的功能
                    features_used = []
                    if self.digital_human.use_wav2lip:
                        features_used.append("Wav2Lip口型同步")
                    if self.digital_human.use_coqui_tts and reference_voice_path:
                        features_used.append("Coqui TTS語音克隆")
                    elif self.digital_human.use_coqui_tts:
                        features_used.append("Coqui TTS")
                    else:
                        features_used.append("基本TTS")
                    
                    feature_text = "（使用: " + ", ".join(features_used) + "）" if features_used else ""
                    self.root.after(0, lambda: messagebox.showinfo("成功", f"數字人視頻已生成:\n{output_path}\n\n{feature_text}"))
                    self.root.after(0, lambda: self.status_label.config(text="數字人視頻生成完成"))
                else:
                    error_msg = "數字人視頻生成失敗。\n\n請檢查:\n"
                    error_msg += "1. 是否安裝了 gTTS (pip install gtts)\n"
                    error_msg += "2. moviepy 是否正常工作\n"
                    error_msg += "3. 模板視頻是否有效\n"
                    if self.digital_human.use_wav2lip:
                        error_msg += "\nWav2Lip配置:\n"
                        if self.digital_human.advanced:
                            available, msg = self.digital_human.advanced.check_wav2lip_available()
                            error_msg += f"  狀態: {'可用' if available else '不可用'}\n"
                            if not available:
                                error_msg += f"  錯誤: {msg}\n"
                    if self.digital_human.use_coqui_tts:
                        error_msg += "\nCoqui TTS配置:\n"
                        if self.digital_human.advanced:
                            available, msg = self.digital_human.advanced.check_coqui_tts_available()
                            error_msg += f"  狀態: {'可用' if available else '不可用'}\n"
                            if not available:
                                error_msg += f"  錯誤: {msg}\n"
                    self.root.after(0, lambda: messagebox.showerror("失敗", error_msg))
                    self.root.after(0, lambda: self.status_label.config(text="生成失敗"))
            except Exception as e:
                import traceback
                err_msg = f"生成數字人視頻時發生錯誤:\n{str(e)}\n\n{traceback.format_exc()}"
                self.root.after(0, lambda: self.show_error_dialog("錯誤", err_msg))
                self.root.after(0, lambda: self.status_label.config(text="生成失敗"))
        
        threading.Thread(target=run, daemon=True).start()

def main():
    # #region agent log
    import os
    debug_log("main", "程序啟動", {
        "version": "with_fix_v2",
        "cwd": os.getcwd(),
        "file_exists": os.path.exists("tiktok_analyzer_app.py")
    }, "A", "initial")
    # #endregion
    root = tk.Tk()
    # #region agent log
    debug_log("main", "GUI創建完成", {}, "A", "initial")
    # #endregion
    app = TikTokAnalyzerApp(root)
    # #region agent log
    debug_log("main", "應用初始化完成", {}, "A", "initial")
    # #endregion
    root.mainloop()

if __name__ == "__main__":
    main()
