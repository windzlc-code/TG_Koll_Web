import requests
import os

def send_request():
    url = 'https://www.runninghub.cn/openapi/v2/run/ai-app/1977410328592031746'
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.getenv('RUNNINGHUB_API_KEY', '')}"
    }
    data = {
        "nodeInfoList": [
            {
                "nodeId": "188",
                "fieldName": "video",
                "fieldValue": "dcce2703edad12a48fa5e6f405d26b7213e5962d16d31c8d7cf8f01981289270.mp4",
                "description": "请导入视频"
            },
            {
                "nodeId": "57",
                "fieldName": "image",
                "fieldValue": "1154c90a7d8e1b9127c4372b9f1c4b33574c8dcfb26f51a2d998306266b42dbf.png",
                "description": "请导入产品图片"
            },
            {
                "nodeId": "197",
                "fieldName": "text",
                "fieldValue": "一个女人在介绍保温杯",
                "description": "请填写简单的提示词"
            },
            {
                "nodeId": "304",
                "fieldName": "value",
                "fieldValue": "保温杯",
                "description": "请填写要被换的产品的中文名称（需要是视频中唯一的名称）"
            },
            {
                "nodeId": "297",
                "fieldName": "int",
                "fieldValue": "10",
                "description": "视频时长（秒）"
            },
            {
                "nodeId": "191",
                "fieldName": "int",
                "fieldValue": "30",
                "description": "视频的帧率"
            },
            {
                "nodeId": "311",
                "fieldName": "int",
                "fieldValue": "576",
                "description": "生成的视频宽度（要是32的倍数）"
            },
            {
                "nodeId": "312",
                "fieldName": "int",
                "fieldValue": "1024",
                "description": "生成的视频长度（要是32的倍数）"
            }
        ],
        "instanceType": "default",
        "usePersonalQueue": "false"
    }
    
    response = requests.post(url, headers=headers, json=data)
    return response.json()
