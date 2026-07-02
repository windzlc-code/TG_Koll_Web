
import asyncio
from pyppeteer import launch
import requests

async def download_video_from_snaptik(tiktok_url):
    """
    Downloads a TikTok video without a watermark from SnapTik.app using pyppeteer.

    Args:
        tiktok_url: The URL of the TikTok video.
    """
    browser = None
    try:
        print("Step 1: Launching a headless browser...")
        browser = await launch(headless=True, executablePath=r'C:\Program Files\Google\Chrome\Application\chrome.exe', args=['--no-sandbox'], timeout=60000)
        page = await browser.newPage()
        print("Browser launched successfully.")

        print("Step 2: Going to SnapTik.app...")
        await page.goto('https://snaptik.app/en', {'waitUntil': 'networkidle2'})
        print("Navigated to SnapTik.app successfully.")

        print("Step 3: Typing the TikTok URL and clicking the download button...")
        await page.type('#url', tiktok_url)
        await page.click('button[type="submit"]')
        print("URL submitted successfully.")

        print("Step 4: Waiting for the download links to appear...")
        await page.waitForSelector('.download-section', {'timeout': 30000})
        print("Download section appeared.")

        print("Step 5: Extracting the download link...")
        download_link = await page.evaluate('''() => {
            const downloadButtons = document.querySelectorAll('.download-section a');
            for (let button of downloadButtons) {
                if (button.href.includes("snaptik")) {
                    return button.href;
                }
            }
            return null;
        }''')

        if not download_link:
            print("Error: Could not find the watermark-free download link.")
            return

        print(f"Found download link: {download_link}")

        print("Step 6: Downloading the video...")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        }
        video_response = requests.get(download_link, headers=headers, stream=True)
        video_response.raise_for_status()

        with open('downloaded_video.mp4', 'wb') as f:
            for chunk in video_response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        print("Video downloaded successfully as downloaded_video.mp4")

    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        if browser:
            print("Closing the browser...")
            await browser.close()
            print("Browser closed.")

if __name__ == '__main__':
    # The user-provided TikTok video URL
    video_url = "https://www.tiktok.com/@user78137726341170/video/7605524629876149512?is_from_webapp=1&sender_device=pc"
    try:
        asyncio.run(download_video_from_snaptik(video_url))
    except Exception as e:
        print(f"An error occurred during asyncio.run: {e}")
