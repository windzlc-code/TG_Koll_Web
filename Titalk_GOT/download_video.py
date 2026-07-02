
import asyncio
from TikTokApi import TikTokApi

async def main():
    async with TikTokApi() as api:
        await api.create_sessions(num_sessions=1)
        user = api.user(username='user78137726341170')
        video = await user.videos().__anext__()
        video_bytes = await video.bytes()
        with open("downloaded_video.mp4", "wb") as out:
            out.write(video_bytes)
        await asyncio.sleep(5) # 等待 5 秒
        print("影片下載完成！")

if __name__ == "__main__":
    asyncio.run(main())
