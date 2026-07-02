
import requests
from bs4 import BeautifulSoup

def download_video_from_ssstik(tiktok_url, output_filename="ssstik_video.mp4"):
    """
    Downloads a TikTok video without a watermark from ssstik.io.

    Args:
        tiktok_url: The URL of the TikTok video.
        output_filename: The filename to save the video as.

    Returns:
        The output filename if successful, otherwise None.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
    }

    try:
        print("Step 1: Sending POST request to ssstik.io...")
        post_data = {
            'id': tiktok_url,
            'locale': 'en',
            'tt': ''
        }
        
        response = requests.post('https://ssstik.io/abc?url=dl', data=post_data, headers=headers)
        response.raise_for_status()
        print("POST request successful.")

        print("Step 2: Parsing the response to find the download link...")
        soup = BeautifulSoup(response.text, 'html.parser')
        
        download_link = soup.find('a', {'class': 'without_watermark'})['href']

        if not download_link:
            print("Error: Could not find the watermark-free download link.")
            return None

        print(f"Found download link: {download_link}")

        print("Step 3: Downloading the video...")
        video_response = requests.get(download_link, headers=headers, stream=True, timeout=60)
        video_response.raise_for_status()

        with open(output_filename, 'wb') as f:
            for chunk in video_response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        print(f"Video downloaded successfully as {output_filename}")
        return output_filename

    except Exception as e:
        print(f"An error occurred: {e}")
        return None

if __name__ == '__main__':
    video_url = "https://www.tiktok.com/@user78137726341170/video/7605524629876149512?is_from_webapp=1&sender_device=pc"
    download_video_from_ssstik(video_url)
