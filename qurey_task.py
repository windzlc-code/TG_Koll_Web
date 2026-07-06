import requests
import json
import os
import time
from typing import Dict, Optional

class TaskQueryClient:
    """任务查询客户端"""

    def __init__(self, api_key: str = None):
        """
        初始化客户端

        Args:
            api_key: API密钥，如果不提供则从环境变量获取
        """
        self.api_key = str(api_key or os.getenv("RUNNINGHUB_API_KEY", "")).strip()
        if not self.api_key:
            raise ValueError("请提供API密钥或设置 RUNNINGHUB_API_KEY 环境变量")

        self.base_url = "https://www.runninghub.cn/openapi/v2"
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }

    def query_task_status(self, task_id: str) -> Optional[Dict]:
        """
        查询任务状态

        Args:
            task_id: 任务ID

        Returns:
            任务状态信息字典
        """
        url = f"{self.base_url}/query"
        payload = {
            "taskId": task_id
        }

        try:
            response = requests.post(url, headers=self.headers, data=json.dumps(payload))
            response.raise_for_status()
            return response.json()

        except requests.exceptions.RequestException as e:
            print(f"查询任务失败: {e}")
            if hasattr(e, 'response') and e.response is not None:
                print(f"错误详情: {e.response.text}")
            return None

    def wait_for_completion(self, task_id: str, max_wait_time: int = 300,
                          poll_interval: int = 10) -> Optional[Dict]:
        """
        等待任务完成

        Args:
            task_id: 任务ID
            max_wait_time: 最大等待时间(秒)
            poll_interval: 轮询间隔(秒)

        Returns:
            最终任务状态
        """
        print(f"开始监控任务 {task_id} 的状态...")
        start_time = time.time()

        while time.time() - start_time < max_wait_time:
            result = self.query_task_status(task_id)

            if result:
                status = result.get('status', '').upper()
                print(f"[{time.strftime('%H:%M:%S')}] 任务状态: {status}")

                if status == 'SUCCESS':
                    print("✅ 任务执行成功!")
                    self._print_results(result)
                    return result

                elif status == 'FAILED':
                    print("❌ 任务执行失败!")
                    self._print_error_info(result)
                    return result

                elif status == 'RUNNING':
                    print(f"⏳ 任务正在运行中...")

                elif status == 'PENDING':
                    print(f"🕒 任务等待中...")

            time.sleep(poll_interval)

        print(f"⏰ 超过最大等待时间 {max_wait_time} 秒")
        return self.query_task_status(task_id)

    def _print_results(self, result: Dict):
        """打印任务结果"""
        results = result.get('results', [])
        if results:
            print("\n🎯 任务结果:")
            for i, item in enumerate(results, 1):
                print(f"  结果 {i}:")
                print(f"    URL: {item.get('url', 'N/A')}")
                print(f"    类型: {item.get('outputType', 'N/A')}")
                if item.get('text'):
                    print(f"    文本: {item.get('text')}")
        else:
            print("⚠️  未找到结果数据")

    def _print_error_info(self, result: Dict):
        """打印错误信息"""
        error_code = result.get('errorCode', 'N/A')
        error_message = result.get('errorMessage', 'N/A')
        failed_reason = result.get('failedReason', {})

        print(f"错误代码: {error_code}")
        print(f"错误信息: {error_message}")
        if failed_reason:
            print(f"失败原因: {json.dumps(failed_reason, indent=2, ensure_ascii=False)}")

def parse_sample_response():
    """解析示例响应数据"""
    sample_data = {
        "taskId": "2013508786110730241",
        "status": "SUCCESS",
        "errorCode": "",
        "errorMessage": "",
        "failedReason": {},
        "usage": {
            "consumeMoney": None,
            "consumeCoins": None,
            "taskCostTime": "0",
            "thirdPartyConsumeMoney": None
        },
        "results": [
            {
                "url": "https://example.invalid/output/generated_image_00001.png",
                "outputType": "png",
                "text": None
            }
        ],
        "clientId": "",
        "promptTips": ""
    }

    print("📋 示例响应数据解析:")
    print("=" * 50)

    # 基本信息
    print(f"任务ID: {sample_data['taskId']}")
    print(f"状态: {sample_data['status']}")

    # 使用情况
    usage = sample_data['usage']
    print(f"耗时: {usage['taskCostTime']} 秒")

    # 结果信息
    results = sample_data['results']
    if results:
        print(f"\n📥 生成结果 ({len(results)} 个):")
        for result in results:
            print(f"  - 类型: {result['outputType']}")
            print(f"  - 下载链接: {result['url']}")

    return sample_data

def main():
    """主函数"""
    print("🚀 RunningHub 任务查询工具")
    print("=" * 40)

    # 解析示例数据
    parse_sample_response()

    # 实际任务查询示例
    print("\n" + "=" * 40)
    print("🔍 实际任务查询示例:")

    try:
        # 初始化客户端
        client = TaskQueryClient()

        # 查询特定任务
        task_id = "2031509015229501441"  # 你的任务ID
        print(f"\n查询任务: {task_id}")

        # 方式1: 直接查询
        result = client.query_task_status(task_id)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))

        # 方式2: 等待任务完成（如果任务还在运行）
        # result = client.wait_for_completion(task_id, max_wait_time=60, poll_interval=5)

    except ValueError as e:
        print(f"配置错误: {e}")
        print("请确保设置了 RUNNINGHUB_API_KEY 环境变量")

if __name__ == "__main__":
    main()
