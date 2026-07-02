import tkinter as tk
from tkinter import ttk
import threading
from ssstik_downloader import download_video_from_ssstik
from remove_watermark import remove_watermark_from_frame
import cv2


def process_video():
    """Wrapper function to run the video processing in a separate thread."""
    url = url_entry.get()
    if not url:
        status_label.config(text="請輸入有效的 TikTok URL")
        return

    def run():
        try:
            status_label.config(text="正在下載影片...")
            download_video_from_ssstik(url)
            status_label.config(text="正在去除浮水印...")

            # Process video to remove watermark
            input_video_path = 'ssstik_video.mp4'
            output_video_path = 'final_video.mp4'

            cap = cv2.VideoCapture(input_video_path)
            if not cap.isOpened():
                raise Exception("無法打開影片文件")

            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = cap.get(cv2.CAP_PROP_FPS)
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            out = cv2.VideoWriter(output_video_path, fourcc, fps, (width, height))

            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                processed_frame = remove_watermark_from_frame(frame)
                out.write(processed_frame)

            cap.release()
            out.release()
            cv2.destroyAllWindows()
            status_label.config(text="處理完成！影片已保存為 final_video.mp4")
        except Exception as e:
            status_label.config(text=f"發生錯誤: {e}")

    # Run the processing in a separate thread to keep the GUI responsive
    thread = threading.Thread(target=run)
    thread.start()


# --- GUI Setup ---
root = tk.Tk()
root.title("TikTok 影片下載器")

mainframe = ttk.Frame(root, padding="12 12 12 12")
mainframe.grid(column=0, row=0, sticky=(tk.W, tk.E, tk.N, tk.S))
root.columnconfigure(0, weight=1)
root.rowconfigure(0, weight=1)

# URL Entry
ttk.Label(mainframe, text="TikTok 影片 URL:").grid(column=1, row=1, sticky=tk.W)
url_entry = ttk.Entry(mainframe, width=50)
url_entry.grid(column=2, row=1, sticky=(tk.W, tk.E))

# Download Button
download_button = ttk.Button(mainframe, text="下載", command=process_video)
download_button.grid(column=2, row=2, sticky=tk.E)

# Status Label
status_label = ttk.Label(mainframe, text="請輸入 URL 並點擊下載")
status_label.grid(column=1, row=3, columnspan=2, sticky=tk.W)

for child in mainframe.winfo_children(): 
    child.grid_configure(padx=5, pady=5)

root.mainloop()
