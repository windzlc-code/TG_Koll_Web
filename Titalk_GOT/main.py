
import argparse
import os
import yt_dlp

def download_video(video_url, output_dir):
    """
    Downloads a TikTok video using yt-dlp.

    Args:
        video_url (str): The URL of the TikTok video to download.
        output_dir (str): The directory to save the downloaded video.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    ydl_opts = {
        'outtmpl': os.path.join(output_dir, '%(title)s.%(ext)s'),
        'format': 'best',
        'quiet': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        print(f"Video successfully downloaded from {video_url}")
    except Exception as e:
        print(f"Error downloading video: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TikTok Video Downloader")
    parser.add_argument("video_url", help="The URL of the TikTok video to download")
    parser.add_argument("--output_dir", default="downloads", help="The directory to save the downloaded video")
    args = parser.parse_args()

    download_video(args.video_url, args.output_dir)
