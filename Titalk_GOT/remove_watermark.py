import cv2
import numpy as np

def remove_watermark_from_frame(frame):
    """Removes the watermark from a single video frame."""
    # Convert to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Create a morphological kernel
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (20, 20))
    
    # Apply morphological closing to fill gaps in the watermark
    closed = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)
    
    # Create a binary mask for the watermark
    mask = cv2.inRange(closed, 200, 255)
    
    # Invert the mask to target the watermark area
    mask = cv2.bitwise_not(mask)
    
    # Use inpainting to remove the watermark
    result = cv2.inpaint(frame, mask, 3, cv2.INPAINT_TELEA)
    
    return result

def process_video_file(input_path, output_path):
    """
    Reads a video from input_path, removes the watermark from each frame,
    and saves the result to output_path.
    """
    # Open the video file
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"錯誤：無法開啟影片檔案 {input_path}")
        return

    # Get video properties
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)

    # Define the codec and create VideoWriter object
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    print(f"正在處理影片：{input_path}")
    
    # Process each frame
    while cap.isOpened():
        ret, frame = cap.read()
        if ret:
            processed_frame = remove_watermark_from_frame(frame)
            out.write(processed_frame)
        else:
            break
    
    print(f"處理完成。輸出已保存至 {output_path}")

    # Release everything when done
    cap.release()
    out.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    process_video_file('ssstik_video.mp4', 'final_video.mp4')
