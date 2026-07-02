# 數字人高級功能配置指南

本指南說明如何配置 Wav2Lip（口型同步）和 Coqui TTS（語音克隆）高級功能。

## 一、Wav2Lip 配置（口型同步）

### 安裝步驟

1. **克隆 Wav2Lip 倉庫**
   ```bash
   git clone https://github.com/Rudrabha/Wav2Lip.git
   cd Wav2Lip
   ```

2. **安裝依賴**
   ```bash
   pip install -r requirements.txt
   ```

3. **下載預訓練模型**
   - 訪問：https://github.com/Rudrabha/Wav2Lip#pre-trained-models
   - 下載 `wav2lip_gan.pth` 檢查點文件
   - 放置到 `Wav2Lip/checkpoints/wav2lip_gan.pth`

4. **在應用中配置**
   - 打開應用程序
   - 點擊「高級設置 (Wav2Lip)」按鈕
   - 設置 Wav2Lip 目錄路徑（例如：`C:\Wav2Lip`）
   - 設置檢查點文件路徑（例如：`C:\Wav2Lip\checkpoints\wav2lip_gan.pth`）
   - 點擊「檢查配置」驗證設置
   - 點擊「保存」

### 使用說明

配置完成後，生成數字人視頻時會自動使用 Wav2Lip 進行高質量口型同步。

## 二、Coqui TTS 配置（語音克隆）

### 安裝步驟

1. **安裝 Coqui TTS**
   ```bash
   pip install TTS
   ```

2. **準備參考語音文件**
   - 準備一個清晰的語音樣本（WAV 或 MP3 格式）
   - 建議時長 3-10 秒
   - 建議使用單人、清晰的語音

3. **在應用中配置**
   - 打開應用程序
   - 在「參考語音」欄位點擊「選擇語音」
   - 選擇您的參考語音文件

### 使用說明

- **有參考語音**：會使用 Coqui TTS 進行語音克隆，生成的語音會模仿參考語音的音色
- **無參考語音**：會使用 Coqui TTS 的默認語音或回退到 gTTS

### 注意事項

- 首次使用時，Coqui TTS 會自動下載模型（約 1-2 GB），需要網絡連接
- 語音克隆需要較好的參考語音質量才能達到最佳效果
- 生成語音可能需要一些時間（取決於文本長度）

## 三、功能層級

應用程序會自動選擇最佳可用功能：

1. **口型同步**：
   - 優先：Wav2Lip（如果已配置）
   - 備用：基本方法（moviepy 合成）

2. **語音生成**：
   - 優先：Coqui TTS + 語音克隆（如果有參考語音）
   - 次選：Coqui TTS 簡單 TTS（如果已安裝）
   - 備用：gTTS 或 pyttsx3

## 四、故障排除

### Wav2Lip 問題

- **錯誤：找不到 inference.py**
  - 確認 Wav2Lip 路徑正確
  - 確認已克隆完整的倉庫

- **錯誤：找不到檢查點文件**
  - 確認檢查點文件路徑正確
  - 確認文件已下載並放置在正確位置

- **執行超時**
  - Wav2Lip 處理可能需要較長時間
  - 嘗試使用較短的視頻或音頻

### Coqui TTS 問題

- **錯誤：TTS 未安裝**
  - 運行：`pip install TTS`
  - 確認安裝成功：`python -c "from TTS.api import TTS; print('OK')"`

- **模型下載失敗**
  - 檢查網絡連接
  - 可能需要代理或 VPN

- **語音克隆效果不佳**
  - 使用更高質量的參考語音
  - 確保參考語音清晰、無背景噪音
  - 參考語音時長建議 3-10 秒

## 五、快速開始（僅基本功能）

如果不需要高級功能，只需安裝基本 TTS：

```bash
pip install gtts
```

應用程序會自動使用基本功能，無需額外配置。
