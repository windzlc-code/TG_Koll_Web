# 快速開始指南

## 1. 安裝依賴

```bash
pip install -r requirements.txt
```

## 2. 配置Gemini API

### 方法1: 使用配置文件
1. 複製 `config.json.example` 為 `config.json`
2. 編輯 `config.json`，填入您的Gemini API Key：
```json
{
    "gemini_api_key": "您的API_KEY"
}
```

### 方法2: 使用環境變量
在Windows PowerShell中：
```powershell
$env:GEMINI_API_KEY="您的API_KEY"
```

在Linux/Mac中：
```bash
export GEMINI_API_KEY="您的API_KEY"
```

## 3. 獲取Gemini API Key

1. 訪問 [Google AI Studio](https://makersuite.google.com/app/apikey)
2. 登錄您的Google帳號
3. 點擊「Create API Key」
4. 複製生成的API Key

## 4. 運行應用

### Windows
雙擊 `run_app.bat` 或運行：
```bash
python tiktok_analyzer_app.py
```

### Linux/Mac
```bash
chmod +x run_app.sh
./run_app.sh
```

或直接運行：
```bash
python3 tiktok_analyzer_app.py
```

## 5. 使用步驟

### 步驟1: 獲取對標帳號視頻
1. 在「對標帳號」區域輸入TikTok用戶名（不需要@符號）
2. 點擊「獲取視頻」按鈕
3. 等待視頻列表加載

### 步驟2: 排序和選擇視頻
- 使用右側的排序選項：
  - **最新**: 按發布時間排序
  - **最多點讚**: 按點讚數排序
  - **最多收藏**: 按收藏數排序
  - **最多分享**: 按分享數排序
- 點擊列表中的視頻進行選擇

### 步驟3: 分析視頻
1. 選擇視頻後，點擊「分析視頻」按鈕
2. 系統會自動下載視頻
3. 使用Gemini AI分析視頻內容
4. 提取的文案會顯示在右側文本區域

### 步驟4: 複製和修改文案
- **複製文案**: 點擊「複製文案」按鈕，將文案複製到剪貼板
- **AI修改**: 點擊「AI修改」按鈕，使用AI修改文案以避免重複

### 步驟5: 生成數字人視頻（可選）
1. 點擊「選擇模板」選擇您的數字人模板視頻
2. 點擊「生成數字人視頻」
3. 注意：完整的數字人功能需要額外的AI工具支持

## 常見問題

### Q: 無法獲取視頻列表？
A: 
- 檢查用戶名是否正確
- 檢查網絡連接
- TikTok可能有反爬蟲機制，請稍後再試

### Q: Gemini分析失敗？
A:
- 確認已正確配置Gemini API Key
- 檢查API配額是否用完
- 確認網絡連接正常

### Q: 數字人功能無法使用？
A:
- 數字人功能需要額外的AI模型支持
- 建議使用Wav2Lip進行口型同步
- 建議使用So-VITS-SVC或Coqui TTS進行語音克隆

### Q: 視頻下載失敗？
A:
- 檢查網絡連接
- 確認視頻URL有效
- 嘗試使用其他下載方法

## 高級功能

### 數字人視頻生成
完整的數字人功能需要安裝以下工具：

1. **Wav2Lip** (口型同步)
   ```bash
   git clone https://github.com/Rudrabha/Wav2Lip.git
   cd Wav2Lip
   pip install -r requirements.txt
   ```

2. **So-VITS-SVC** (語音克隆)
   ```bash
   git clone https://github.com/svc-develop-team/so-vits-svc.git
   cd so-vits-svc
   pip install -r requirements.txt
   ```

3. **Coqui TTS** (語音合成)
   ```bash
   pip install TTS
   ```

安裝後，可以在 `digital_human_advanced.py` 中配置路徑。

## 技術支持

如遇到問題，請檢查：
1. Python版本（建議3.8+）
2. 所有依賴是否正確安裝
3. API配置是否正確
4. 網絡連接是否正常
