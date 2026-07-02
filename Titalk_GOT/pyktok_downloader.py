
import pyktok as pyk

# Set the user agent
pyk.specify_browser('chrome')

# The user-provided TikTok video URL
video_url = "https://www.tiktok.com/@user78137726341170/video/7605524629876149512?is_from_webapp=1&sender_device=pc"

# Download the video
pyk.save_tiktok(video_url, True, 'pyktok_video.mp4', None)

print("Video downloaded successfully as pyktok_video.mp4")
