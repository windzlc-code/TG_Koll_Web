
import asyncio
from pyppeteer import launch
import requests

async def main():
    browser = await launch(
        executablePath=r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        headless=True,  # Re-enable headless mode for automation
        args=['--window-size=1920,1080']
    )
    page = await browser.newPage()

    # 偽裝成真實瀏覽器
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36')
    await page.setViewport({'width': 1920, 'height': 1080})
    await page.evaluateOnNewDocument('() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }) }')

    # 使用您提供的單一影片頁面連結
    await page.goto('https://www.tiktok.com/@user78137726341170/video/7605524629876149512?is_from_webapp=1&sender_device=pc')

    # 等待頁面載入，給予足夠時間處理反爬蟲機制
    print("頁面載入中，請稍候 15 秒...")
    await asyncio.sleep(15)

    # 截圖，看看頁面長什麼樣子
    print("正在截圖...")
    await page.screenshot({'path': 'tiktok_page.png'})
    print("截圖完成！儲存為 tiktok_page.png")

    # 等待影片元素載入
    print("正在尋找影片元素...")
    try:
        await page.waitForSelector('video', {'timeout': 10000}) # Wait for 10 seconds
        print("影片元素已找到！")

        # 執行 JavaScript，獲取影片 src
        video_url = await page.evaluate('() => document.querySelector("video").src')

        if not video_url or video_url.startswith('blob:'):
            print("獲取到的 video_url 是 blob 或為空，無法直接下載。")
            await browser.close()
            return

        print(f"找到影片 URL: {video_url}")

        # 下載影片
        print("正在下載影片...")
        response = requests.get(video_url, stream=True)
        with open('downloaded_video.mp4', 'wb') as f:
            for chunk in response.iter_content(chunk_size=1024):
                if chunk:
                    f.write(chunk)
        print("影片下載完成！")

    except Exception as e:
        print(f"尋找或下載影片時發生錯誤: {e}")


    await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
