# TikTok 對標帳號分析與數字人應用

這是一個功能完整的TikTok對標帳號分析工具，可以自動提取帳號的所有作品，進行排序、分析和文案提取，並支持數字人視頻生成。

## 功能特點

1. **帳號對標與視頻提取**
   - 輸入TikTok用戶名，自動獲取該帳號的所有視頻
   - 支持批量下載視頻

2. **視頻排序功能**
   - 按最新發布時間排序
   - 按最多點讚數排序
   - 按最多收藏數排序
   - 按最多分享數排序

3. **Gemini視頻分析**
   - 自動分析視頻內容
   - 提取視頻中的文案和字幕
   - 生成視頻標題和描述建議

4. **AI文案修改**
   - 使用Gemini AI修改文案
   - 避免重複和抄襲
   - 保持原意和風格

5. **數字人功能**
   - 支持自定義數字人模板
   - 口型同步（需要Wav2Lip）
   - 語音克隆（需要So-VITS-SVC或Coqui TTS）

## 安裝步驟

1. **安裝Python依賴**
```bash
pip install -r requirements.txt
```

2. **配置Gemini API**
   - 複製 `config.json.example` 為 `config.json`
   - 在 `config.json` 中填入您的Gemini API Key
   - 或者設置環境變量 `GEMINI_API_KEY`

3. **運行應用**
```bash
python tiktok_analyzer_app.py
```

## 使用說明

### 1. 獲取對標帳號視頻
- 在「對標帳號」區域輸入TikTok用戶名（不需要@符號）
- 點擊「獲取視頻」按鈕
- 等待視頻列表加載完成

### 2. 排序和選擇視頻
- 使用排序選項按不同條件排序視頻
- 點擊列表中的視頻進行選擇

### 3. 分析視頻
- 選擇視頻後，點擊「分析視頻」按鈕
- 系統會自動下載視頻並使用Gemini進行分析
- 分析結果會顯示在「提取的文案」區域

### 4. 複製和修改文案
- 點擊「複製文案」將文案複製到剪貼板
- 點擊「AI修改」使用AI修改文案，避免重複

### 5. 生成數字人視頻
- 選擇數字人模板（開車場景或室外場景）
- 點擊「生成數字人視頻」
- 注意：完整的數字人功能需要額外的AI模型支持

## 高級功能說明

### 數字人視頻生成
完整的數字人功能需要以下工具：
- **Wav2Lip**: 用於口型同步
- **So-VITS-SVC** 或 **Coqui TTS**: 用於語音克隆

這些工具需要單獨安裝和配置。本應用提供了基礎框架，可以集成這些工具。

### Gemini API配置
1. 訪問 [Google AI Studio](https://makersuite.google.com/app/apikey)
2. 創建API Key
3. 在 `config.json` 中配置或設置環境變量

## 注意事項

- TikTok的API訪問可能受到限制，如果無法獲取視頻，請檢查網絡連接
- Gemini API有使用限制，請注意API配額
- 數字人功能需要額外的AI模型，本應用提供基礎框架
- 請遵守TikTok的使用條款和版權法律

## 文件結構

```
vedio/
├── tiktok_analyzer_app.py    # 主應用程序
├── requirements.txt           # Python依賴
├── config.json.example        # 配置文件示例
├── config.json               # 配置文件（需要創建）
├── downloaded_videos/         # 下載的視頻目錄
├── scripts/                  # 提取的文案目錄
└── output/                   # 輸出文件目錄
```

## 技術棧

- **GUI**: tkinter
- **視頻處理**: yt-dlp, moviepy, opencv-python
- **AI分析**: google-generativeai (Gemini)
- **網絡請求**: requests

## 許可證

本項目僅供學習和研究使用。
