"""
高級數字人功能模塊
支持Wav2Lip口型同步和語音克隆
"""

import os
import subprocess
import sys
from typing import Optional

class AdvancedDigitalHuman:
    """高級數字人功能，需要外部工具支持"""
    
    def __init__(self):
        self.wav2lip_path = None
        self.wav2lip_checkpoint = None
        self.tts_model_path = None
        self.use_wav2lip = False
        self.use_coqui_tts = False
    
    def set_wav2lip_path(self, wav2lip_path: str, checkpoint_path: str = None):
        """設置Wav2Lip路徑和檢查點"""
        self.wav2lip_path = wav2lip_path
        if checkpoint_path:
            self.wav2lip_checkpoint = checkpoint_path
        else:
            # 默認檢查點路徑
            self.wav2lip_checkpoint = os.path.join(wav2lip_path, 'checkpoints', 'wav2lip_gan.pth')
        self.use_wav2lip = True
    
    def check_wav2lip_available(self):
        # 返回 (是否可用, 錯誤信息)
        """檢查Wav2Lip是否可用，返回(是否可用, 錯誤信息)"""
        if not self.wav2lip_path:
            return False, "未設置Wav2Lip路徑"
        
        if not os.path.exists(self.wav2lip_path):
            return False, f"Wav2Lip路徑不存在: {self.wav2lip_path}"
        
        inference_script = os.path.join(self.wav2lip_path, 'inference.py')
        if not os.path.exists(inference_script):
            return False, f"找不到 inference.py: {inference_script}"
        
        if not os.path.exists(self.wav2lip_checkpoint):
            return False, f"找不到檢查點文件: {self.wav2lip_checkpoint}"
        
        return True, ""
    
    def sync_lip_wav2lip(self, video_path: str, audio_path: str, output_path: str):
        # 返回 (是否成功, 消息)
        """
        使用Wav2Lip進行口型同步
        
        需要先安裝Wav2Lip:
        git clone https://github.com/Rudrabha/Wav2Lip.git
        cd Wav2Lip
        pip install -r requirements.txt
        下載檢查點: https://github.com/Rudrabha/Wav2Lip#pre-trained-models
        """
        available, error_msg = self.check_wav2lip_available()
        if not available:
            return False, f"Wav2Lip不可用: {error_msg}"
        
        try:
            inference_script = os.path.join(self.wav2lip_path, 'inference.py')
            
            # 構建命令
            cmd = [
                sys.executable,
                inference_script,
                '--checkpoint_path', self.wav2lip_checkpoint,
                '--face', video_path,
                '--audio', audio_path,
                '--outfile', output_path
            ]
            
            # 執行Wav2Lip
            result = subprocess.run(
                cmd,
                cwd=self.wav2lip_path,
                capture_output=True,
                text=True,
                timeout=600  # 10分鐘超時
            )
            
            if result.returncode == 0:
                if os.path.exists(output_path):
                    return True, "Wav2Lip口型同步成功"
                else:
                    return False, "Wav2Lip執行完成但未生成輸出文件"
            else:
                error_output = result.stderr or result.stdout
                return False, f"Wav2Lip執行失敗: {error_output[:500]}"
        except subprocess.TimeoutExpired:
            return False, "Wav2Lip執行超時（超過10分鐘）"
        except Exception as e:
            return False, f"Wav2Lip執行異常: {str(e)}"
    
    def clone_voice_sovits(self, text: str, reference_voice_path: str, output_path: str) -> bool:
        """
        使用So-VITS-SVC進行語音克隆
        
        需要先安裝So-VITS-SVC:
        git clone https://github.com/svc-develop-team/so-vits-svc.git
        """
        try:
            # 這裡需要根據實際的So-VITS-SVC API調用
            # 示例代碼（需要根據實際情況調整）
            print("語音克隆功能需要So-VITS-SVC支持")
            print("請參考: https://github.com/svc-develop-team/so-vits-svc")
            return False
        except Exception as e:
            print(f"語音克隆失敗: {e}")
            return False
    
    def check_coqui_tts_available(self):
        # 返回 (是否可用, 錯誤信息)
        """檢查Coqui TTS是否可用"""
        try:
            from TTS.api import TTS
            return True, ""
        except ImportError:
            return False, "Coqui TTS未安裝，請運行: pip install TTS"
        except Exception as e:
            return False, f"Coqui TTS檢查失敗: {str(e)}"
    
    def clone_voice_coqui(self, text: str, reference_voice_path: str, output_path: str, 
                         language: str = 'zh'):
        # 返回 (是否成功, 消息)
        """
        使用Coqui TTS進行語音克隆
        
        安裝: pip install TTS
        模型會自動下載
        """
        available, error_msg = self.check_coqui_tts_available()
        if not available:
            return False, error_msg
        
        if not os.path.exists(reference_voice_path):
            return False, f"參考語音文件不存在: {reference_voice_path}"
        
        try:
            from TTS.api import TTS
            
            # 初始化TTS模型（支持語音克隆的模型）
            # your_tts 支持多語言和語音克隆
            model_name = "tts_models/multilingual/multi-dataset/your_tts"
            
            print(f"正在加載Coqui TTS模型: {model_name}...")
            tts = TTS(model_name=model_name, gpu=False, progress_bar=False)
            
            print("正在進行語音克隆...")
            # 進行語音克隆
            tts.tts_to_file(
                text=text,
                file_path=output_path,
                speaker_wav=reference_voice_path,
                language=language
            )
            
            if os.path.exists(output_path):
                return True, "Coqui TTS語音克隆成功"
            else:
                return False, "語音克隆完成但未生成輸出文件"
        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            return False, f"Coqui TTS語音克隆失敗: {str(e)}\n{error_detail[:500]}"
    
    def clone_voice_coqui_simple(self, text: str, output_path: str, language: str = 'zh'):
        # 返回 (是否成功, 消息)
        """使用Coqui TTS進行簡單TTS（無語音克隆）"""
        available, error_msg = self.check_coqui_tts_available()
        if not available:
            return False, error_msg
        
        try:
            from TTS.api import TTS
            
            # 使用多語言模型
            model_name = "tts_models/multilingual/multi-dataset/your_tts"
            print(f"正在加載Coqui TTS模型: {model_name}...")
            tts = TTS(model_name=model_name, gpu=False, progress_bar=False)
            
            print("正在生成語音...")
            tts.tts_to_file(text=text, file_path=output_path, language=language)
            
            if os.path.exists(output_path):
                return True, "Coqui TTS語音生成成功"
            else:
                return False, "語音生成完成但未生成輸出文件"
        except Exception as e:
            return False, f"Coqui TTS語音生成失敗: {str(e)}"
