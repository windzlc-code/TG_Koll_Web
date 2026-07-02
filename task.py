import requests
import base64
import os

# 配置
API_URL = os.getenv("IMAGE_MODEL_API_URL", "").strip()
API_KEY = os.getenv("IMAGE_MODEL_API_KEY", "").strip() or os.getenv("IMAGE_MODEL_PROVIDER_API_KEY_GEMINI", "").strip()
if not API_URL:
    raise RuntimeError("请先设置 IMAGE_MODEL_API_URL 环境变量")
if not API_KEY:
    raise RuntimeError("请先设置 IMAGE_MODEL_API_KEY 或 IMAGE_MODEL_PROVIDER_API_KEY_GEMINI 环境变量")

# 读取并编码图片
with open("./img.png", "rb") as f:
    image_base64 = base64.b64encode(f.read()).decode("utf-8")

# 构建请求
headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

payload = {
    "contents": [
        {
            "role": "user",
            "parts": [
                {"text": "What's in this image?"},
                {
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": image_base64
                    }
                }
            ]
        }
    ]
}

# 发送请求
response = requests.post(API_URL, headers=headers, json=payload, timeout=60)
print(f"状态码: {response.status_code}")
print(f"响应: {response.text}")
