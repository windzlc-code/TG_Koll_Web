
import tkinter as tk
from tkinter import ttk, messagebox
import threading
from TikTokApi import TikTokApi
from ssstik_downloader import download_video_from_ssstik
from remove_watermark import process_video_file
from PIL import Image, ImageTk
import requests
from io import BytesIO

def fetch_videos():
    """Fetch videos from a TikTok user's profile."""
    username = username_entry.get()
    if not username:
        messagebox.showerror("錯誤", "請輸入 TikTok 用戶名")
        return

    def run():
        try:
            status_label.config(text=f"正在獲取 {username} 的影片列表...")
            with TikTokApi() as api:
                user = api.user(username)
                videos = [video.as_dict for video in user.videos()]
                display_videos(videos)
        except Exception as e:
            status_label.config(text=f"獲取影片列表時發生錯誤: {e}")

    thread = threading.Thread(target=run)
    thread.start()

def display_videos(videos):
    """Display video thumbnails and titles in the GUI."""
    for widget in video_frame.winfo_children():
        widget.destroy()

    for i, video in enumerate(videos):
        video_info = video['video']
        cover_url = video_info['cover']
        
        # Download thumbnail
        response = requests.get(cover_url)
        img_data = response.content
        img = Image.open(BytesIO(img_data))
        img.thumbnail((120, 180))
        photo = ImageTk.PhotoImage(img)
        
        var = tk.BooleanVar()
        chk = ttk.Checkbutton(video_frame, image=photo, text=video['desc'], variable=var, compound=tk.TOP)
        chk.image = photo
        chk.grid(row=i, column=0, sticky=tk.W, pady=5)
        video_checkboxes.append((var, video['id']))

def download_selected_videos():
    """Download selected videos."""
    selected_videos = [video_id for var, video_id in video_checkboxes if var.get()]
    if not selected_videos:
        messagebox.showwarning("警告", "請至少選擇一個影片")
        return

    def run():
        for video_id in selected_videos:
            try:
                status_label.config(text=f"正在下載影片 {video_id}...")
                video_url = f"https://www.tiktok.com/@{username_entry.get()}/video/{video_id}"
                temp_path = f"temp_{video_id}.mp4"
                final_path = f"final_{video_id}.mp4"
                download_video_from_ssstik(video_url, temp_path)
                status_label.config(text=f"正在為影片 {video_id} 去除浮水印...")
                process_video_file(temp_path, final_path)
            except Exception as e:
                status_label.config(text=f"處理影片 {video_id} 時發生錯誤: {e}")
        status_label.config(text="所有選定的影片都已處理完畢！")

    thread = threading.Thread(target=run)
    thread.start()

# --- GUI Setup ---
root = tk.Tk()
root.title("TikTok 影片批量下載器")

mainframe = ttk.Frame(root, padding="12 12 12 12")
mainframe.grid(column=0, row=0, sticky=(tk.W, tk.E, tk.N, tk.S))

# --- Controls ---
controls_frame = ttk.Frame(mainframe)
controls_frame.grid(column=0, row=0, sticky=(tk.W, tk.E))
ttk.Label(controls_frame, text="TikTok 用戶名:").pack(side=tk.LEFT, padx=5)
username_entry = ttk.Entry(controls_frame, width=30)
username_entry.pack(side=tk.LEFT, padx=5)
fetch_button = ttk.Button(controls_frame, text="獲取影片", command=fetch_videos)
fetch_button.pack(side=tk.LEFT, padx=5)

# --- Video List ---
canvas = tk.Canvas(mainframe)
scrollbar = ttk.Scrollbar(mainframe, orient="vertical", command=canvas.yview)
video_frame = ttk.Frame(canvas)

video_frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
canvas.create_window((0, 0), window=video_frame, anchor="nw")
canvas.configure(yscrollcommand=scrollbar.set)

canvas.grid(column=0, row=1, sticky=(tk.W, tk.E, tk.N, tk.S))
scrollbar.grid(column=1, row=1, sticky=(tk.N, tk.S))
mainframe.rowconfigure(1, weight=1)
mainframe.columnconfigure(0, weight=1)

# --- Download Button & Status ---
bottom_frame = ttk.Frame(mainframe)
bottom_frame.grid(column=0, row=2, sticky=(tk.W, tk.E))
download_button = ttk.Button(bottom_frame, text="下載選定的影片", command=download_selected_videos)
download_button.pack(side=tk.RIGHT, pady=10)
status_label = ttk.Label(bottom_frame, text="請輸入用戶名並點擊 '獲取影片'")
status_label.pack(side=tk.LEFT, pady=10)

video_checkboxes = []

root.mainloop()
