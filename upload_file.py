import requests
import os
import mimetypes

def upload_image_to_runninghub(api_key: str, file_path: str) -> dict | None:
    """
    上传图片到 RunningHub API
    :param api_key: 你的 RunningHub API Key
    :param file_path: 本地图片路径
    :return: 成功返回包含下载链接等信息的字典，失败返回 None
    """
    url = "https://www.runninghub.cn/openapi/v2/media/upload/binary"
    headers = {
        "Authorization": f"Bearer {api_key}"
    }

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"文件不存在: {file_path}")

    # 自动识别图片 MIME 类型
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type or not mime_type.startswith("image/"):
        mime_type = "application/octet-stream"

    try:
        with open(file_path, "rb") as f:
            # requests 会自动处理 multipart/form-data 格式
            files = {
                "file": (os.path.basename(file_path), f, mime_type)
            }
            response = requests.post(url, headers=headers, files=files, timeout=30)

        response.raise_for_status()  # 非 2xx 状态码会抛出异常
        result = response.json()

        # RunningHub 业务状态码校验
        if result.get("code") == 0:
            print("✅ 上传成功！")
            data = result["data"]
            print(f"📄 文件名: {data['fileName']}")
            print(f"🔗 临时下载链接: {data['download_url']}")
            print(f"📏 文件大小: {data['size']} 字节")
            print("⚠️ 注意: 该链接有效期仅为 24 小时，请及时用于工作流或本地备份")
            return data
        else:
            print(f"❌ API 业务错误: {result.get('message')}")
            return None

    except requests.exceptions.RequestException as e:
        print(f"❌ 网络请求异常: {e}")
        return None
    except ValueError:
        print("❌ 服务器响应不是有效的 JSON 格式")
        return None

if __name__ == "__main__":
    # 替换为你的真实 API Key（在 RunningHub 控制台获取）
    YOUR_API_KEY = os.getenv("RUNNINGHUB_API_KEY", "")
    if not YOUR_API_KEY:
        raise RuntimeError("请先设置 RUNNINGHUB_API_KEY 环境变量")
    # 🖼️ 替换为本地图片路径
    YOUR_IMAGE_PATH = "./img.png"

    upload_image_to_runninghub(YOUR_API_KEY, YOUR_IMAGE_PATH)
