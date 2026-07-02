import http.client
import json
import base64
import os
import mimetypes


def get_mime_type(file_path: str) -> str:
    """获取文件的 MIME 类型"""
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type is None:
        ext = os.path.splitext(file_path)[1].lower()
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        return mime_map.get(ext, "application/octet-stream")
    return mime_type


def gemini_image_inference(
    image_path: str,
    prompt: str = "请详细描述这张图片的内容。",
    api_key: str = "",
    host: str = "api.tu-zi.com",
    model: str = "gemini-3-pro-preview"
) -> str:
    """
    调用 Gemini API 进行图片推理

    Args:
        image_path: 图片文件路径
        prompt: 提示词
        api_key: API Key
        host: API 主机地址
        model: 模型名称

    Returns:
        AI 返回的文本结果
    """
    # 检查文件是否存在
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"图片文件不存在: {image_path}")

    # 读取并 base64 编码图片
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    base64_data = base64.b64encode(image_bytes).decode("utf-8")

    # 获取 MIME 类型
    mime_type = get_mime_type(image_path)

    # 构造请求体
    payload = json.dumps({
        "contents": [
            {
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64_data
                        }
                    },
                    {
                        "text": prompt
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 2048
        }
    })

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }

    # 发送请求
    conn = http.client.HTTPSConnection(host)
    try:
        conn.request(
            "POST",
            f"/v1beta/models/{model}:generateContent",
            payload,
            headers
        )
        res = conn.getresponse()
        data = res.read().decode("utf-8")

        # 解析响应
        if res.status != 200:
            print(f"❌ 请求失败，状态码: {res.status}")
            print(f"响应内容: {data}")
            return None

        response_json = json.loads(data)

        # 提取文本内容
        candidates = response_json.get("candidates", [])
        if candidates:
            text = candidates[0]["content"]["parts"][0]["text"]
            return text
        else:
            print(f"❌ 未找到有效响应: {data}")
            return None

    except Exception as e:
        print(f"❌ 请求异常: {e}")
        return None
    finally:
        conn.close()


if __name__ == "__main__":
    # 🔧 配置参数
    IMAGE_PATH = "./img.png"  # 替换为你的图片路径
    PROMPT = "你看到了什么？请详细描述这张图片的内容。"
    API_KEY = os.getenv("GEMINI_API_KEY", "")
    if not API_KEY:
        raise RuntimeError("请先设置 GEMINI_API_KEY 环境变量")

    # 执行图片推理
    result = gemini_image_inference(
        image_path=IMAGE_PATH,
        prompt=PROMPT,
        api_key=API_KEY
    )

    if result:
        print("\n✅ 识别结果:\n")
        print(result)
    else:
        print("\n❌ 识别失败")
