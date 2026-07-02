
import sys
import os
from ssstik_downloader import download_video_from_ssstik
from remove_watermark import process_video_file

def main():
    if len(sys.argv) < 2:
        print("用法: python run.py <tiktok_url>")
        sys.exit(1)

    tiktok_url = sys.argv[1]
    temp_video_path = "temp_video.mp4"
    final_video_path = "final_video.mp4"
    
    try:
        # Step 1: Download the video
        print("--- 步驟 1: 正在下載影片 ---")
        downloaded_file = download_video_from_ssstik(tiktok_url, temp_video_path)
        if not downloaded_file:
            print("下載失敗。正在退出。")
            sys.exit(1)
        
        # Step 2: Remove the watermark
        print("\n--- 步驟 2: 正在去除浮水印 ---")
        process_video_file(downloaded_file, final_video_path)
        
        print(f"\n--- 全部完成！ ---")
        print(f"最終的影片已保存為: {final_video_path}")

    except Exception as e:
        print(f"發生未預期的錯誤: {e}")
    finally:
        # Clean up the temporary file
        if os.path.exists(temp_video_path):
            os.remove(temp_video_path)
            print(f"\n已刪除臨時檔案: {temp_video_path}")

if __name__ == "__main__":
    main()
