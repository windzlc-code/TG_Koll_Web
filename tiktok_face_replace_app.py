from __future__ import annotations

import json
import os
import multiprocessing as mp
import queue
import sys
import threading
import traceback
from dataclasses import asdict
from datetime import datetime
from typing import Any

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, scrolledtext, ttk
except ModuleNotFoundError:
    tk = None
    filedialog = None
    messagebox = None
    scrolledtext = None
    ttk = None

import replace_model
from WorkFlow import WorkflowSettings, regenerate_single_video

try:
    from PIL import Image, ImageTk
except Exception:
    Image = None
    ImageTk = None


def _run_project_in_process(settings_dict: dict[str, Any], out_queue: Any) -> None:
    from WorkFlow import WorkflowSettings, run_tiktok_face_replace_project

    def emit(event: str, payload: dict[str, Any]) -> None:
        try:
            out_queue.put((event, payload))
        except Exception:
            return

    try:
        settings = WorkflowSettings(**settings_dict)
        result = run_tiktok_face_replace_project(
            settings,
            logger=print,
            emit=emit,
            stop_requested=None,
        )
        emit("done", result)
    except Exception:
        print(traceback.format_exc())
        emit("error", {"traceback": traceback.format_exc()})


class TikTokFaceReplaceApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("TikTok 人物替换工作台")
        self.root.geometry("1480x920")
        self.root.minsize(1200, 760)

        self.colors = {
            "bg": "#f6f7fb",
            "panel": "#ffffff",
            "muted": "#f1f3f8",
            "border": "#e5e7eb",
            "text": "#111827",
            "subtext": "#6b7280",
            "accent": "#2563eb",
            "accent2": "#4338ca",
            "danger": "#dc2626",
            "success": "#16a34a",
            "log_bg": "#0b1220",
            "log_fg": "#e5e7eb",
        }
        self.root.configure(bg=self.colors["bg"])

        self.proc: mp.Process | None = None
        self.proc_queue: Any = None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.current_manifest_path: str = ""
        self.preview_photo = None
        self.persist_path = os.path.join(os.path.dirname(__file__), ".tiktok_face_replace_last.json")

        self._build_style()
        self._build_layout()
        self._load_persisted_config()

    def _build_style(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure(
            "Card.TFrame",
            background=self.colors["panel"],
            borderwidth=1,
            relief="solid",
        )
        style.configure(
            "Title.TLabel",
            background=self.colors["bg"],
            foreground=self.colors["text"],
            font=("Segoe UI", 22, "bold"),
        )
        style.configure(
            "Hint.TLabel",
            background=self.colors["bg"],
            foreground=self.colors["subtext"],
            font=("Segoe UI", 10),
        )
        style.configure(
            "Field.TLabel",
            background=self.colors["panel"],
            foreground=self.colors["subtext"],
            font=("Segoe UI", 10, "bold"),
        )
        style.configure(
            "Primary.TButton",
            font=("Segoe UI", 10, "bold"),
            background=self.colors["accent"],
            foreground="#ffffff",
            padding=8,
        )
        style.map("Primary.TButton", background=[("active", self.colors["accent2"])])
        style.configure(
            "Ghost.TButton",
            font=("Segoe UI", 10, "bold"),
            background=self.colors["muted"],
            foreground=self.colors["text"],
            padding=8,
        )
        style.map("Ghost.TButton", background=[("active", "#e8ebf5")])
        style.configure(
            "Danger.TButton",
            font=("Segoe UI", 10, "bold"),
            background=self.colors["danger"],
            foreground="#ffffff",
            padding=8,
        )
        style.map("Danger.TButton", background=[("active", "#b91c1c")])

    def _card(self, parent: tk.Widget) -> ttk.Frame:
        frame = ttk.Frame(parent, style="Card.TFrame")
        frame.configure(padding=14)
        return frame

    def _build_layout(self) -> None:
        self.root.grid_rowconfigure(1, weight=1)
        self.root.grid_columnconfigure(0, weight=1)

        header = tk.Frame(self.root, bg=self.colors["bg"])
        header.grid(row=0, column=0, sticky="ew", padx=18, pady=(14, 10))
        header.grid_columnconfigure(0, weight=1)

        tk.Label(header, text="TikTok 人物替换工作台", bg=self.colors["bg"], fg=self.colors["text"], font=("Segoe UI", 22, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        tk.Label(
            header,
            text="下载账号视频 → Gemini 定位关键帧 → 抽帧 → Nano Banana 生图 → replace_model 输出最终视频",
            bg=self.colors["bg"],
            fg=self.colors["subtext"],
            font=("Segoe UI", 10),
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))

        main = tk.Frame(self.root, bg=self.colors["bg"])
        main.grid(row=1, column=0, sticky="nsew", padx=18, pady=(0, 16))
        main.grid_rowconfigure(0, weight=1)
        main.grid_columnconfigure(0, weight=1)

        panes = ttk.Panedwindow(main, orient="horizontal")
        panes.grid(row=0, column=0, sticky="nsew")

        left = self._card(panes)
        left.grid_columnconfigure(0, weight=1)
        left.grid_rowconfigure(0, weight=1)

        right = self._card(panes)

        left.configure(width=560)
        right.configure(width=920)
        panes.add(left, weight=3)
        panes.add(right, weight=4)

        def set_sash() -> None:
            try:
                total = int(panes.winfo_width() or 0)
                if total > 0:
                    panes.sashpos(0, int(total * 0.36))
            except Exception:
                return

        self.root.after(50, set_sash)

        left_canvas = tk.Canvas(left, bg=self.colors["panel"], bd=0, highlightthickness=0)
        left_scroll = ttk.Scrollbar(left, orient="vertical", command=left_canvas.yview)
        left_canvas.configure(yscrollcommand=left_scroll.set)
        left_canvas.grid(row=0, column=0, sticky="nsew")
        left_scroll.grid(row=0, column=1, sticky="ns")

        left_inner = tk.Frame(left_canvas, bg=self.colors["panel"])
        left_window = left_canvas.create_window((0, 0), window=left_inner, anchor="nw")

        def on_inner_configure(_event: Any) -> None:
            left_canvas.configure(scrollregion=left_canvas.bbox("all"))

        def on_canvas_configure(event: Any) -> None:
            left_canvas.itemconfigure(left_window, width=event.width)

        def on_mousewheel(event: Any) -> None:
            delta = getattr(event, "delta", 0)
            if not delta:
                return
            step = -1 if delta > 0 else 1
            left_canvas.yview_scroll(step, "units")

        def on_enter(_event: Any) -> None:
            self.root.bind_all("<MouseWheel>", on_mousewheel)

        def on_leave(_event: Any) -> None:
            self.root.unbind_all("<MouseWheel>")

        left_inner.bind("<Configure>", on_inner_configure)
        left_canvas.bind("<Configure>", on_canvas_configure)
        left_canvas.bind("<Enter>", on_enter)
        left_canvas.bind("<Leave>", on_leave)

        self._build_config_panel(left_inner)
        self._build_result_panel(right)

    def _build_config_panel(self, parent: ttk.Frame) -> None:
        parent.grid_rowconfigure(99, weight=1)

        title = tk.Label(parent, text="任务配置", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 14, "bold"))
        title.grid(row=0, column=0, sticky="w", pady=(0, 10))

        form = tk.Frame(parent, bg=self.colors["panel"])
        form.grid(row=1, column=0, sticky="nsew")
        form.grid_columnconfigure(1, weight=1)

        def label(text: str, r: int) -> None:
            tk.Label(form, text=text, bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 10, "bold")).grid(
                row=r, column=0, sticky="w", pady=(8, 4)
            )

        self.username_var = tk.StringVar(value="")
        self.max_videos_var = tk.StringVar(value="20")
        self.enable_tiktok_download_var = tk.BooleanVar(value=True)
        self.video_folder_var = tk.StringVar(value="")
        self.image_folder_var = tk.StringVar(value="")
        self.skip_generate_image_var = tk.BooleanVar(value=False)
        self.image_match_mode_var = tk.StringVar(value="cycle")
        self.fixed_image_index_var = tk.StringVar(value="1")
        self.output_root_var = tk.StringVar(value=os.path.abspath("./outputs_tiktok_replace"))
        self.gemini_host_var = tk.StringVar(value=os.getenv("GEMINI_HOST", "202.90.21.53"))
        self.gemini_port_var = tk.StringVar(value=os.getenv("GEMINI_PORT", "3008"))
        self.gemini_key_var = tk.StringVar(value=os.getenv("GEMINI_API_KEY", ""))
        self.nano_host_var = tk.StringVar(value=os.getenv("NANO_HOST", "202.90.21.53"))
        self.nano_port_var = tk.StringVar(value=os.getenv("NANO_PORT", "3008"))
        self.nano_key_var = tk.StringVar(value=os.getenv("NANO_API_KEY", ""))
        self.runninghub_key_var = tk.StringVar(value=os.getenv("RUNNINGHUB_API_KEY", ""))
        self.runninghub_app_id_var = tk.StringVar(value=os.getenv("RUNNINGHUB_APP_ID", replace_model.DEFAULT_APP_ID))
        self.output_fps_var = tk.StringVar(value="30")
        self.output_width_var = tk.StringVar(value="576")
        self.output_height_var = tk.StringVar(value="1024")
        self.output_duration_var = tk.StringVar(value="10")
        self.use_custom_duration_var = tk.BooleanVar(value=False)
        self.upload_ip_var = tk.StringVar(value="")
        self.upload_port_var = tk.StringVar(value="")
        self.remember_keys_var = tk.BooleanVar(value=True)

        label("TikTok 用户名", 0)
        ttk.Entry(form, textvariable=self.username_var).grid(row=0, column=1, sticky="ew")

        label("启用 TikTok 下载", 1)
        tk.Checkbutton(
            form,
            text="启用",
            variable=self.enable_tiktok_download_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).grid(row=1, column=1, sticky="w")

        label("最多下载视频数", 2)
        ttk.Entry(form, textvariable=self.max_videos_var, width=10).grid(row=2, column=1, sticky="w")

        label("本地视频文件夹(可空)", 3)
        video_row = tk.Frame(form, bg=self.colors["panel"])
        video_row.grid(row=3, column=1, sticky="ew")
        video_row.grid_columnconfigure(0, weight=1)
        ttk.Entry(video_row, textvariable=self.video_folder_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(video_row, text="选择", style="Ghost.TButton", command=self._choose_video_dir).grid(row=0, column=1, padx=(8, 0))

        label("本地图片文件夹(可空)", 4)
        image_row = tk.Frame(form, bg=self.colors["panel"])
        image_row.grid(row=4, column=1, sticky="ew")
        image_row.grid_columnconfigure(0, weight=1)
        ttk.Entry(image_row, textvariable=self.image_folder_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(image_row, text="选择", style="Ghost.TButton", command=self._choose_image_dir).grid(row=0, column=1, padx=(8, 0))

        label("跳过抽帧与生图", 5)
        tk.Checkbutton(
            form,
            text="启用(有图片文件夹时建议)",
            variable=self.skip_generate_image_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).grid(row=5, column=1, sticky="w")

        label("图片配对策略", 6)
        match_row = tk.Frame(form, bg=self.colors["panel"])
        match_row.grid(row=6, column=1, sticky="w")
        tk.Radiobutton(
            match_row,
            text="循环复用",
            value="cycle",
            variable=self.image_match_mode_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).grid(row=0, column=0, sticky="w")
        tk.Radiobutton(
            match_row,
            text="固定指定",
            value="fixed",
            variable=self.image_match_mode_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).grid(row=0, column=1, sticky="w", padx=(10, 0))
        tk.Label(match_row, text="序号", bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 9, "bold")).grid(
            row=0, column=2, sticky="w", padx=(12, 4)
        )
        ttk.Entry(match_row, textvariable=self.fixed_image_index_var, width=6).grid(row=0, column=3, sticky="w")

        label("输出目录", 7)
        out_row = tk.Frame(form, bg=self.colors["panel"])
        out_row.grid(row=7, column=1, sticky="ew")
        out_row.grid_columnconfigure(0, weight=1)
        ttk.Entry(out_row, textvariable=self.output_root_var).grid(row=0, column=0, sticky="ew")
        ttk.Button(out_row, text="选择", style="Ghost.TButton", command=self._choose_output_dir).grid(row=0, column=1, padx=(8, 0))

        sep = ttk.Separator(parent, orient="horizontal")
        sep.grid(row=2, column=0, sticky="ew", pady=12)

        api_title = tk.Label(parent, text="API 配置", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 14, "bold"))
        api_title.grid(row=3, column=0, sticky="w", pady=(0, 8))

        label("Gemini Host", 8)
        ttk.Entry(form, textvariable=self.gemini_host_var).grid(row=8, column=1, sticky="ew")

        label("Gemini Port(可空)", 9)
        ttk.Entry(form, textvariable=self.gemini_port_var, width=10).grid(row=9, column=1, sticky="w")

        label("Gemini API Key", 10)
        ttk.Entry(form, textvariable=self.gemini_key_var, show="*").grid(row=10, column=1, sticky="ew")

        label("Nano Host", 11)
        ttk.Entry(form, textvariable=self.nano_host_var).grid(row=11, column=1, sticky="ew")

        label("Nano Port(可空)", 12)
        ttk.Entry(form, textvariable=self.nano_port_var, width=10).grid(row=12, column=1, sticky="w")

        label("Nano API Key", 13)
        ttk.Entry(form, textvariable=self.nano_key_var, show="*").grid(row=13, column=1, sticky="ew")

        label("RunningHub API Key", 14)
        ttk.Entry(form, textvariable=self.runninghub_key_var, show="*").grid(row=14, column=1, sticky="ew")

        remember_row = tk.Frame(form, bg=self.colors["panel"])
        remember_row.grid(row=14, column=2, sticky="w", padx=(10, 0))
        tk.Checkbutton(
            remember_row,
            text="记住密钥",
            variable=self.remember_keys_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).pack(anchor="w")

        label("RunningHub App ID", 15)
        ttk.Entry(form, textvariable=self.runninghub_app_id_var).grid(row=15, column=1, sticky="ew")

        label("资源上传服务器 IP(可空)", 16)
        ttk.Entry(form, textvariable=self.upload_ip_var).grid(row=16, column=1, sticky="ew")

        label("资源上传端口(可空)", 17)
        ttk.Entry(form, textvariable=self.upload_port_var, width=10).grid(row=17, column=1, sticky="w")

        label("输出帧率", 18)
        ttk.Entry(form, textvariable=self.output_fps_var, width=10).grid(row=18, column=1, sticky="w")

        label("输出宽度", 19)
        ttk.Entry(form, textvariable=self.output_width_var, width=10).grid(row=19, column=1, sticky="w")

        label("输出高度", 20)
        ttk.Entry(form, textvariable=self.output_height_var, width=10).grid(row=20, column=1, sticky="w")

        label("自定义视频时长", 21)
        tk.Checkbutton(
            form,
            text="启用",
            variable=self.use_custom_duration_var,
            bg=self.colors["panel"],
            fg=self.colors["subtext"],
            activebackground=self.colors["panel"],
            selectcolor=self.colors["muted"],
            font=("Segoe UI", 9, "bold"),
        ).grid(row=21, column=1, sticky="w")

        label("自定义时长(秒)", 22)
        ttk.Entry(form, textvariable=self.output_duration_var, width=10).grid(row=22, column=1, sticky="w")

        nano_prompt_title = tk.Label(parent, text="生图提示词（Nano Banana，可改）", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 14, "bold"))
        nano_prompt_title.grid(row=4, column=0, sticky="w", pady=(18, 8))

        self.nano_prompt_text = tk.Text(parent, height=3, wrap="word", font=("Segoe UI", 10), bg=self.colors["muted"], fg=self.colors["text"], bd=0)
        self.nano_prompt_text.grid(row=5, column=0, sticky="ew")
        self.nano_prompt_text.insert(
            "1.0",
            "生成相似但非同一人的新人物，保持原图的姿势、服装、场景与光照。",
        )

        replace_prompt_title = tk.Label(parent, text="人物替换提示词（replace_model，可改）", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 14, "bold"))
        replace_prompt_title.grid(row=6, column=0, sticky="w", pady=(14, 8))

        self.replace_prompt_text = tk.Text(parent, height=3.3, wrap="word", font=("Segoe UI", 10), bg=self.colors["muted"], fg=self.colors["text"], bd=0)
        self.replace_prompt_text.grid(row=7, column=0, sticky="ew")
        self.replace_prompt_text.insert(
            "1.0",
            "保持原视频的动作、镜头、节奏、场景与光照一致，仅替换人物为上传图片中的人物。",
        )

        actions = tk.Frame(parent, bg=self.colors["panel"])
        actions.grid(row=98, column=0, sticky="ew", pady=(14, 0))
        actions.grid_columnconfigure(0, weight=1)

        self.run_btn = ttk.Button(actions, text="开始运行", style="Primary.TButton", command=self._start)
        self.run_btn.grid(row=0, column=0, sticky="ew")

        self.stop_btn = ttk.Button(actions, text="停止", style="Danger.TButton", command=self._stop)
        self.stop_btn.grid(row=0, column=1, sticky="ew", padx=(10, 0))

        self.open_btn = ttk.Button(actions, text="打开项目目录", style="Ghost.TButton", command=self._open_project_dir)
        self.open_btn.grid(row=1, column=0, sticky="ew", pady=(10, 0))

        self.load_btn = ttk.Button(actions, text="加载 manifest", style="Ghost.TButton", command=self._load_manifest)
        self.load_btn.grid(row=1, column=1, sticky="ew", padx=(10, 0), pady=(10, 0))

    def _load_persisted_config(self) -> None:
        if not os.path.exists(self.persist_path):
            return
        try:
            with open(self.persist_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return

        def set_if(var: tk.Variable, key: str) -> None:
            if key in data and str(data.get(key, "")).strip():
                try:
                    var.set(data.get(key))
                except Exception:
                    return

        set_if(self.username_var, "username")
        set_if(self.max_videos_var, "max_videos")
        set_if(self.output_root_var, "output_root")
        set_if(self.gemini_host_var, "gemini_host")
        set_if(self.gemini_port_var, "gemini_port")
        set_if(self.nano_host_var, "nano_host")
        set_if(self.nano_port_var, "nano_port")
        set_if(self.runninghub_app_id_var, "runninghub_app_id")
        try:
            if "enable_tiktok_download" in data:
                self.enable_tiktok_download_var.set(bool(data.get("enable_tiktok_download")))
        except Exception:
            pass
        set_if(self.video_folder_var, "video_folder")
        set_if(self.image_folder_var, "image_folder")
        try:
            if "skip_generate_image" in data:
                self.skip_generate_image_var.set(bool(data.get("skip_generate_image")))
        except Exception:
            pass
        set_if(self.image_match_mode_var, "image_match_mode")
        set_if(self.fixed_image_index_var, "fixed_image_index")
        set_if(self.output_fps_var, "output_fps")
        set_if(self.output_width_var, "output_width")
        set_if(self.output_height_var, "output_height")
        set_if(self.output_duration_var, "output_duration_seconds")
        try:
            if "use_custom_duration" in data:
                self.use_custom_duration_var.set(bool(data.get("use_custom_duration")))
        except Exception:
            pass
        set_if(self.upload_ip_var, "upload_ip")
        set_if(self.upload_port_var, "upload_port")

        legacy_app_id = "1973816801870131202"
        current_app_id = str(self.runninghub_app_id_var.get() or "").strip()
        migrated = False
        if not current_app_id or current_app_id == legacy_app_id:
            try:
                self.runninghub_app_id_var.set(replace_model.DEFAULT_APP_ID)
            except Exception:
                pass
            migrated = bool(current_app_id == legacy_app_id)
        if migrated and isinstance(data, dict):
            try:
                data["runninghub_app_id"] = replace_model.DEFAULT_APP_ID
                with open(self.persist_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            except Exception:
                pass

        remember = bool(data.get("remember_keys", False))
        try:
            self.remember_keys_var.set(remember)
        except Exception:
            pass

        if remember:
            set_if(self.gemini_key_var, "gemini_key")
            set_if(self.nano_key_var, "nano_key")
            set_if(self.runninghub_key_var, "runninghub_key")

        nano_prompt = str(data.get("nano_prompt", "")).strip()
        if nano_prompt and hasattr(self, "nano_prompt_text"):
            try:
                self.nano_prompt_text.delete("1.0", "end")
                self.nano_prompt_text.insert("1.0", nano_prompt)
            except Exception:
                pass

        replace_prompt = str(data.get("replace_prompt", "")).strip()
        if replace_prompt and hasattr(self, "replace_prompt_text"):
            try:
                self.replace_prompt_text.delete("1.0", "end")
                self.replace_prompt_text.insert("1.0", replace_prompt)
            except Exception:
                pass

        last_manifest = str(data.get("last_manifest_path", "")).strip()
        if last_manifest and os.path.exists(last_manifest):
            self.current_manifest_path = last_manifest

    def _save_persisted_config(self) -> None:
        data: dict[str, Any] = {
            "username": self.username_var.get().strip(),
            "max_videos": self.max_videos_var.get().strip(),
            "enable_tiktok_download": bool(self.enable_tiktok_download_var.get()),
            "video_folder": self.video_folder_var.get().strip(),
            "image_folder": self.image_folder_var.get().strip(),
            "skip_generate_image": bool(self.skip_generate_image_var.get()),
            "image_match_mode": str(self.image_match_mode_var.get() or "").strip() or "cycle",
            "fixed_image_index": self.fixed_image_index_var.get().strip(),
            "output_root": self.output_root_var.get().strip(),
            "gemini_host": self.gemini_host_var.get().strip(),
            "gemini_port": self.gemini_port_var.get().strip(),
            "nano_host": self.nano_host_var.get().strip(),
            "nano_port": self.nano_port_var.get().strip(),
            "runninghub_app_id": self.runninghub_app_id_var.get().strip(),
            "output_fps": self.output_fps_var.get().strip(),
            "output_width": self.output_width_var.get().strip(),
            "output_height": self.output_height_var.get().strip(),
            "output_duration_seconds": self.output_duration_var.get().strip(),
            "use_custom_duration": bool(self.use_custom_duration_var.get()),
            "upload_ip": self.upload_ip_var.get().strip(),
            "upload_port": self.upload_port_var.get().strip(),
            "nano_prompt": self.nano_prompt_text.get("1.0", "end").strip() if hasattr(self, "nano_prompt_text") else "",
            "replace_prompt": self.replace_prompt_text.get("1.0", "end").strip() if hasattr(self, "replace_prompt_text") else "",
            "remember_keys": bool(self.remember_keys_var.get()),
            "last_manifest_path": self.current_manifest_path,
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }
        if data["remember_keys"]:
            data["gemini_key"] = self.gemini_key_var.get().strip()
            data["nano_key"] = self.nano_key_var.get().strip()
            data["runninghub_key"] = self.runninghub_key_var.get().strip()
        else:
            data["gemini_key"] = ""
            data["nano_key"] = ""
            data["runninghub_key"] = ""

        try:
            with open(self.persist_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            return

    def _build_result_panel(self, parent: ttk.Frame) -> None:
        parent.grid_columnconfigure(0, weight=1)
        parent.grid_rowconfigure(2, weight=1)

        title = tk.Label(parent, text="运行状态", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 14, "bold"))
        title.grid(row=0, column=0, sticky="w", pady=(0, 10))

        top = tk.Frame(parent, bg=self.colors["panel"])
        top.grid(row=1, column=0, sticky="ew")
        top.grid_columnconfigure(0, weight=1)

        self.status_var = tk.StringVar(value="空闲")
        self.status_label = tk.Label(top, textvariable=self.status_var, bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 10))
        self.status_label.grid(row=0, column=0, sticky="w")

        self.progress = ttk.Progressbar(top, mode="determinate", maximum=100.0)
        self.progress["value"] = 0.0
        self.progress.grid(row=0, column=1, sticky="e", padx=(10, 0))

        splitter = ttk.Panedwindow(parent, orient="horizontal")
        splitter.grid(row=2, column=0, sticky="nsew", pady=(10, 0))

        left = ttk.Frame(splitter)
        left.configure(padding=0)
        right = ttk.Frame(splitter)
        right.configure(padding=0)
        splitter.add(left, weight=2)
        splitter.add(right, weight=3)

        self._build_video_list(left)
        self._build_log_panel(right)

    def _build_video_list(self, parent: ttk.Frame) -> None:
        parent.grid_rowconfigure(1, weight=1)
        parent.grid_columnconfigure(0, weight=1)

        tk.Label(parent, text="视频列表", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, sticky="w", padx=2, pady=(0, 8)
        )

        columns = ("video_id", "timestamp", "status", "versions")
        tree = ttk.Treeview(parent, columns=columns, show="headings", height=12)
        self.tree = tree
        tree.heading("video_id", text="视频ID")
        tree.heading("timestamp", text="时间戳")
        tree.heading("status", text="状态")
        tree.heading("versions", text="版本")
        tree.column("video_id", width=160, anchor="w")
        tree.column("timestamp", width=90, anchor="center")
        tree.column("status", width=90, anchor="center")
        tree.column("versions", width=70, anchor="center")
        tree.grid(row=1, column=0, sticky="nsew")
        tree.bind("<<TreeviewSelect>>", self._on_select_item)

        actions = tk.Frame(parent, bg=self.colors["panel"])
        actions.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        actions.grid_columnconfigure(1, weight=1)

        ttk.Button(actions, text="预览最新视频", style="Ghost.TButton", command=self._preview_selected).grid(row=0, column=0, sticky="w")
        ttk.Button(actions, text="打开文件夹", style="Ghost.TButton", command=self._open_selected_folder).grid(row=0, column=1, sticky="w", padx=(8, 0))

        tk.Label(actions, text="重生成修改建议", bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 10, "bold")).grid(
            row=1, column=0, sticky="w", pady=(10, 4)
        )
        self.feedback_text = tk.Text(actions, height=4, wrap="word", font=("Segoe UI", 10), bg=self.colors["muted"], fg=self.colors["text"], bd=0)
        self.feedback_text.grid(row=2, column=0, columnspan=2, sticky="ew")

        ttk.Button(actions, text="重生成所选视频", style="Primary.TButton", command=self._regenerate_selected).grid(
            row=3, column=0, sticky="ew", columnspan=2, pady=(10, 0)
        )

        preview_wrap = tk.Frame(parent, bg=self.colors["panel"])
        preview_wrap.grid(row=3, column=0, sticky="ew", pady=(12, 0))
        preview_wrap.grid_columnconfigure(1, weight=1)
        tk.Label(preview_wrap, text="帧预览", bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 10, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        self.preview_label = tk.Label(preview_wrap, text="未选择", bg=self.colors["panel"], fg=self.colors["subtext"], font=("Segoe UI", 10))
        self.preview_label.grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.preview_canvas = tk.Label(preview_wrap, bg=self.colors["panel"])
        self.preview_canvas.grid(row=0, column=1, rowspan=2, sticky="e")

    def _build_log_panel(self, parent: ttk.Frame) -> None:
        parent.grid_rowconfigure(1, weight=1)
        parent.grid_columnconfigure(0, weight=1)

        tk.Label(parent, text="日志 / 进度", bg=self.colors["panel"], fg=self.colors["text"], font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, sticky="w", padx=2, pady=(0, 8)
        )

        self.log_box = scrolledtext.ScrolledText(
            parent,
            height=20,
            wrap="word",
            font=("Consolas", 10),
            bg=self.colors["log_bg"],
            fg=self.colors["log_fg"],
            bd=0,
            insertbackground=self.colors["log_fg"],
        )
        self.log_box.grid(row=1, column=0, sticky="nsew")

        bottom = tk.Frame(parent, bg=self.colors["panel"])
        bottom.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        ttk.Button(bottom, text="清空日志", style="Ghost.TButton", command=lambda: self.log_box.delete("1.0", "end")).pack(side="left")
        ttk.Button(bottom, text="导出日志", style="Ghost.TButton", command=self._export_log).pack(side="left", padx=(8, 0))

    def _choose_output_dir(self) -> None:
        path = filedialog.askdirectory(title="选择输出目录")
        if path:
            self.output_root_var.set(os.path.abspath(path))

    def _choose_video_dir(self) -> None:
        path = filedialog.askdirectory(title="选择视频文件夹")
        if path:
            self.video_folder_var.set(os.path.abspath(path))

    def _choose_image_dir(self) -> None:
        path = filedialog.askdirectory(title="选择图片文件夹")
        if path:
            self.image_folder_var.set(os.path.abspath(path))

    def _append_log(self, text: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        self.log_box.insert("end", f"[{ts}] {text}\n")
        self.log_box.see("end")

    def _append_log_event(self, payload: dict[str, Any]) -> None:
        message = str(payload.get("message", "")).strip()
        level = str(payload.get("level", "")).strip()
        prefix = f"[{level}] " if level else ""
        tb = payload.get("traceback")
        extras = {k: v for k, v in payload.items() if k not in {"time", "level", "message", "traceback"}}
        prompt_text = extras.pop("prompt", None)
        raw_preview = extras.pop("raw_preview", None)
        if extras:
            try:
                extra_text = json.dumps(extras, ensure_ascii=False)
            except Exception:
                extra_text = str(extras)
            extra_text = extra_text.replace("\n", " ").replace("\r", " ")
            if len(extra_text) > 1400:
                extra_text = extra_text[:1400] + "…"
            if message:
                self._append_log(f"{prefix}{message} | {extra_text}")
                if isinstance(tb, str) and tb.strip():
                    self._append_log(tb.strip())
                if isinstance(raw_preview, str) and raw_preview.strip():
                    self._append_log(raw_preview.rstrip())
                if isinstance(prompt_text, str) and prompt_text.strip():
                    self._append_log(prompt_text.rstrip())
                return
            self._append_log(f"{prefix}{extra_text}")
            if isinstance(tb, str) and tb.strip():
                self._append_log(tb.strip())
            if isinstance(raw_preview, str) and raw_preview.strip():
                self._append_log(raw_preview.rstrip())
            if isinstance(prompt_text, str) and prompt_text.strip():
                self._append_log(prompt_text.rstrip())
            return
        if message:
            self._append_log(f"{prefix}{message}")
            if isinstance(tb, str) and tb.strip():
                self._append_log(tb.strip())
            if isinstance(raw_preview, str) and raw_preview.strip():
                self._append_log(raw_preview.rstrip())
            if isinstance(prompt_text, str) and prompt_text.strip():
                self._append_log(prompt_text.rstrip())

    def _start(self) -> None:
        if self.proc and self.proc.is_alive():
            return
        enable_tiktok_download = bool(self.enable_tiktok_download_var.get())
        username = self.username_var.get().strip()
        video_folder = self.video_folder_var.get().strip()
        image_folder = self.image_folder_var.get().strip()
        skip_generate_image = bool(self.skip_generate_image_var.get()) or bool(image_folder)
        image_match_mode = str(self.image_match_mode_var.get() or "").strip() or "cycle"
        fixed_image_index_text = str(self.fixed_image_index_var.get() or "").strip() or "1"

        if enable_tiktok_download:
            if not username:
                messagebox.showerror("参数错误", "启用了 TikTok 下载时，请填写 TikTok 用户名。")
                return
        else:
            if not video_folder:
                if image_folder:
                    messagebox.showerror("参数错误", "只上传了图片，请再上传视频文件夹，或开启 TikTok 下载。")
                    return
                messagebox.showerror("参数错误", "关闭 TikTok 下载时，请填写本地视频文件夹。")
                return
            if not os.path.isdir(video_folder):
                messagebox.showerror("参数错误", "本地视频文件夹路径不存在或不可用。")
                return

        if image_folder and not os.path.isdir(image_folder):
            messagebox.showerror("参数错误", "本地图片文件夹路径不存在或不可用。")
            return

        if image_match_mode not in {"cycle", "fixed"}:
            messagebox.showerror("参数错误", "图片配对策略无效。")
            return

        try:
            fixed_image_index = int(fixed_image_index_text)
        except Exception:
            messagebox.showerror("参数错误", "固定图片序号必须是整数。")
            return
        if fixed_image_index <= 0:
            messagebox.showerror("参数错误", "固定图片序号必须大于 0。")
            return

        try:
            max_videos = int((self.max_videos_var.get() or "20").strip())
        except Exception:
            messagebox.showerror("参数错误", "最多下载视频数必须是整数。")
            return

        output_root = self.output_root_var.get().strip() or "./outputs_tiktok_replace"
        gemini_host = self.gemini_host_var.get().strip() or "202.90.21.53"
        nano_host = self.nano_host_var.get().strip() or "202.90.21.53"
        gemini_key = self.gemini_key_var.get().strip()
        nano_key = self.nano_key_var.get().strip()
        runninghub_key = self.runninghub_key_var.get().strip()

        if not skip_generate_image:
            if not gemini_key:
                messagebox.showerror("参数错误", "未跳过生图时，请填写 Gemini API Key。")
                return
            if not nano_key:
                messagebox.showerror("参数错误", "未跳过生图时，请填写 Nano API Key。")
                return
        if not runninghub_key:
            messagebox.showerror("参数错误", "请填写 RunningHub API Key。")
            return

        gemini_port_text = self.gemini_port_var.get().strip()
        nano_port_text = self.nano_port_var.get().strip()
        upload_ip = self.upload_ip_var.get().strip() or None
        upload_port_text = self.upload_port_var.get().strip()

        def parse_int(value: str) -> int | None:
            if not value:
                return None
            return int(value)

        try:
            gemini_port = parse_int(gemini_port_text)
            nano_port = parse_int(nano_port_text)
            upload_port = parse_int(upload_port_text)
        except Exception:
            messagebox.showerror("参数错误", "端口必须是整数或留空。")
            return

        if upload_ip and upload_port is None:
            messagebox.showerror("参数错误", "填写了资源上传服务器IP时，端口不能为空。")
            return

        runninghub_app_id = self.runninghub_app_id_var.get().strip() or replace_model.DEFAULT_APP_ID

        def parse_required_int(value: str, default: int, name: str) -> int:
            text = str(value or "").strip()
            if not text:
                return int(default)
            try:
                num = int(text)
            except Exception:
                raise ValueError(f"{name} 必须是整数")
            if num <= 0:
                raise ValueError(f"{name} 必须大于 0")
            return num

        try:
            output_fps = parse_required_int(self.output_fps_var.get(), 30, "输出帧率")
            output_width = parse_required_int(self.output_width_var.get(), 576, "输出宽度")
            output_height = parse_required_int(self.output_height_var.get(), 1024, "输出高度")
            use_custom_duration = bool(self.use_custom_duration_var.get())
            if use_custom_duration:
                output_duration_seconds = parse_required_int(self.output_duration_var.get(), 10, "自定义时长(秒)")
            else:
                output_duration_seconds = 0
        except Exception as exc:
            messagebox.showerror("参数错误", str(exc))
            return

        nano_prompt = self.nano_prompt_text.get("1.0", "end").strip() if hasattr(self, "nano_prompt_text") else ""
        if not nano_prompt:
            nano_prompt = "生成相似但非同一人的新人物，保持原图的姿势、服装、场景与光照。"

        replace_prompt = self.replace_prompt_text.get("1.0", "end").strip()
        if not replace_prompt:
            replace_prompt = "保持原视频内容一致，仅替换人物。"

        self._clear_results()
        self.status_var.set("运行中…")
        self.progress["value"] = 0.0
        self._append_log("开始运行任务。")

        settings = WorkflowSettings(
            username=username,
            output_root=output_root,
            max_videos=max(max_videos, 1),
            enable_tiktok_download=enable_tiktok_download,
            video_folder=video_folder or None,
            image_folder=image_folder or None,
            skip_generate_image=skip_generate_image,
            image_match_mode=image_match_mode,
            fixed_image_index=fixed_image_index,
            gemini_host=gemini_host,
            gemini_port=gemini_port,
            gemini_api_key=gemini_key,
            nano_host=nano_host,
            nano_port=nano_port,
            nano_api_key=nano_key,
            runninghub_api_key=runninghub_key,
            runninghub_replace_app_id=runninghub_app_id,
            upload_server_ip=upload_ip,
            upload_server_port=upload_port,
            nano_prompt=nano_prompt,
            replace_prompt=replace_prompt,
            output_fps=output_fps,
            output_width=output_width,
            output_height=output_height,
            output_duration_seconds=output_duration_seconds,
            use_custom_duration=use_custom_duration,
        )

        self._save_persisted_config()

        ctx = mp.get_context("spawn")
        self.proc_queue = ctx.Queue()
        self.proc = ctx.Process(target=_run_project_in_process, args=(asdict(settings), self.proc_queue), daemon=True)
        self.proc.start()
        self.root.after(120, self._poll_events)

    def _stop(self) -> None:
        if self.proc and self.proc.is_alive():
            self._append_log("用户请求停止任务，正在终止进程…")
            try:
                self.proc.terminate()
                self.proc.join(timeout=1.0)
            except Exception:
                pass
            self.progress["value"] = 0.0
            self.status_var.set("已停止")
            return
        self.root.destroy()

    def _poll_events(self) -> None:
        if self.proc_queue is None:
            return
        while True:
            try:
                event, payload = self.proc_queue.get_nowait()
            except queue.Empty:
                break

            if event == "log_text":
                self._append_log(str(payload.get("text", "")).strip())
                continue

            if event == "log":
                if isinstance(payload, dict):
                    self._append_log_event(payload)
                continue

            if event == "project_init":
                if isinstance(payload, dict):
                    for vid in payload.get("video_ids") or []:
                        video_id = str(vid).strip()
                        if not video_id:
                            continue
                        if not self.tree.exists(video_id):
                            self.tree.insert("", "end", iid=video_id, values=(video_id, "", "pending", "0"))
                    project_dir = str(payload.get("project_dir", "")).strip()
                    if project_dir:
                        self._append_log(f"项目目录：{project_dir}")
                continue

            if event == "video_item":
                if isinstance(payload, dict):
                    video_id = str(payload.get("video_id", "")).strip()
                    status = str(payload.get("status", "")).strip() or "unknown"
                    if video_id:
                        if not self.tree.exists(video_id):
                            self.tree.insert("", "end", iid=video_id, values=(video_id, "", status, "0"))
                        else:
                            vals = list(self.tree.item(video_id, "values") or [])
                            while len(vals) < 4:
                                vals.append("")
                            vals[2] = status
                            self.tree.item(video_id, values=tuple(vals))
                continue

            if event == "progress":
                if isinstance(payload, dict):
                    percent = payload.get("percent")
                    try:
                        value = float(percent)
                    except Exception:
                        value = None
                    if value is not None:
                        self.progress["value"] = max(min(value, 100.0), 0.0)
                    phase = str(payload.get("phase", "")).strip()
                    video_id = str(payload.get("video_id", "")).strip()
                    detail = str(payload.get("detail", "")).strip()
                    status_text = phase
                    if video_id:
                        status_text = f"{video_id} | {phase}"
                    if detail:
                        status_text = f"{status_text} | {detail}"
                    if value is not None:
                        status_text = f"{status_text} | {value:.1f}%"
                    if status_text:
                        self.status_var.set(status_text)
                    if video_id and self.tree.exists(video_id):
                        vals = list(self.tree.item(video_id, "values") or [])
                        while len(vals) < 4:
                            vals.append("")
                        if phase == "replace_model" and detail:
                            vals[2] = f"RUNNING {detail}"
                        self.tree.item(video_id, values=tuple(vals))
                continue

            if event == "download_done":
                self._append_log(f"下载完成：{payload.get('count')} 个视频")
                continue

            if event == "final":
                self._append_log(f"输出视频：{payload.get('video_id')} status={payload.get('status')} path={payload.get('path')}")
                continue

            if event == "done":
                self.progress["value"] = 100.0
                self.status_var.set("已完成")
                self.current_manifest_path = str(payload.get("manifest_path", "")).strip()
                self._append_log(f"任务完成，manifest={self.current_manifest_path}")
                self._load_manifest_from_path(self.current_manifest_path)
                self._save_persisted_config()
                continue

            if event == "error":
                self.progress["value"] = 0.0
                self.status_var.set("失败")
                self._append_log("任务失败：")
                self._append_log(str(payload.get("traceback", "")).strip())
                self._save_persisted_config()
                messagebox.showerror("执行失败", "任务执行失败，请查看日志定位。")
                continue

        if self.proc and self.proc.is_alive():
            self.root.after(120, self._poll_events)
        else:
            pass

    def _clear_results(self) -> None:
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.preview_label.configure(text="未选择")
        self.preview_canvas.configure(image="")
        self.preview_photo = None
        self.current_manifest_path = ""

    def _load_manifest(self) -> None:
        path = filedialog.askopenfilename(title="选择 manifest.json", filetypes=[("manifest", "*.json"), ("All", "*.*")])
        if path:
            self._load_manifest_from_path(path)

    def _load_manifest_from_path(self, path: str) -> None:
        if not path or not os.path.exists(path):
            messagebox.showerror("加载失败", f"manifest 不存在: {path}")
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception as exc:
            messagebox.showerror("加载失败", f"无法解析 manifest: {exc}")
            return

        self._clear_results()
        self.current_manifest_path = path

        for item in manifest.get("items", []):
            video_id = str(item.get("video_id", "")).strip()
            timestamp = str(item.get("timestamp", "")).strip()
            versions = item.get("final_versions") or []
            latest = versions[-1] if versions else {}
            status = str(latest.get("status", "")).strip() or "unknown"
            self.tree.insert("", "end", iid=video_id, values=(video_id, timestamp, status, str(len(versions))))

        self._append_log(f"已加载 manifest：{path}")

    def _selected_video_id(self) -> str:
        selected = self.tree.selection()
        if not selected:
            return ""
        return str(selected[0])

    def _on_select_item(self, _event: Any = None) -> None:
        video_id = self._selected_video_id()
        if not video_id or not self.current_manifest_path:
            return
        try:
            with open(self.current_manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            return
        items = manifest.get("items") or []
        target = None
        for item in items:
            if str(item.get("video_id", "")) == video_id:
                target = item
                break
        if target is None:
            return
        frame_path = str(target.get("frame_image_path", "")).strip()
        self.preview_label.configure(text=os.path.basename(frame_path) if frame_path else "无帧图")
        self._render_thumbnail(frame_path)

    def _render_thumbnail(self, frame_path: str) -> None:
        if Image is None or ImageTk is None:
            self.preview_canvas.configure(image="")
            self.preview_photo = None
            return
        if not frame_path or not os.path.exists(frame_path):
            self.preview_canvas.configure(image="")
            self.preview_photo = None
            return
        try:
            img = Image.open(frame_path)
            img.thumbnail((220, 140))
            photo = ImageTk.PhotoImage(img)
            self.preview_photo = photo
            self.preview_canvas.configure(image=photo)
        except Exception:
            self.preview_canvas.configure(image="")
            self.preview_photo = None

    def _latest_video_path(self, video_id: str) -> str:
        if not self.current_manifest_path or not os.path.exists(self.current_manifest_path):
            return ""
        with open(self.current_manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        for item in manifest.get("items", []):
            if str(item.get("video_id", "")) != video_id:
                continue
            versions = item.get("final_versions") or []
            if not versions:
                return ""
            return str(versions[-1].get("path", "")).strip()
        return ""

    def _preview_selected(self) -> None:
        video_id = self._selected_video_id()
        if not video_id:
            messagebox.showinfo("提示", "请先选择一个视频条目。")
            return
        path = self._latest_video_path(video_id)
        if not path or not os.path.exists(path):
            messagebox.showerror("预览失败", "未找到可播放的视频文件。")
            return
        self._open_path(path)

    def _open_selected_folder(self) -> None:
        video_id = self._selected_video_id()
        if not video_id:
            return
        path = self._latest_video_path(video_id)
        if not path:
            return
        self._open_path(os.path.dirname(path))

    def _open_project_dir(self) -> None:
        if not self.current_manifest_path:
            messagebox.showinfo("提示", "当前没有项目目录可打开，请先运行或加载 manifest。")
            return
        try:
            with open(self.current_manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            return
        project_dir = str(manifest.get("project_dir", "")).strip() or os.path.dirname(self.current_manifest_path)
        self._open_path(project_dir)

    def _open_path(self, path: str) -> None:
        target = os.path.abspath(path)
        try:
            if os.name == "nt":
                os.startfile(target)  # type: ignore[attr-defined]
            elif os.name == "posix":
                import subprocess
                if sys.platform == "darwin":
                    subprocess.Popen(["open", target])
                else:
                    subprocess.Popen(["xdg-open", target])
        except Exception as exc:
            messagebox.showerror("打开失败", str(exc))

    def _regenerate_selected(self) -> None:
        video_id = self._selected_video_id()
        if not video_id:
            messagebox.showinfo("提示", "请先选择一个视频条目。")
            return
        if not self.current_manifest_path:
            messagebox.showerror("提示", "未加载 manifest。")
            return
        api_key = self.runninghub_key_var.get().strip()
        if not api_key:
            messagebox.showerror("参数错误", "请填写 RunningHub API Key。")
            return
        feedback = self.feedback_text.get("1.0", "end").strip()

        self._append_log(f"[重生成] 准备重生成: {video_id}")
        self.progress.start(10)

        def work() -> None:
            try:
                result = regenerate_single_video(
                    manifest_path=self.current_manifest_path,
                    video_id=video_id,
                    feedback=feedback,
                    api_key=api_key,
                    logger=lambda msg: self.events.put(("log_text", {"text": msg})),
                )
                self.events.put(("regen_done", {"video_id": video_id, "result": result}))
            except Exception:
                self.events.put(("regen_error", {"traceback": traceback.format_exc()}))

        threading.Thread(target=work, daemon=True).start()
        self.root.after(120, self._poll_regen_events)

    def _poll_regen_events(self) -> None:
        handled = False
        while True:
            try:
                event, payload = self.events.get_nowait()
            except queue.Empty:
                break

            if event == "log_text":
                self._append_log(str(payload.get("text", "")).strip())
                handled = True
                continue

            if event == "regen_done":
                self.progress.stop()
                video_id = str(payload.get("video_id", ""))
                result = payload.get("result") or {}
                self._append_log(f"[重生成完成] {video_id} status={result.get('status')} path={result.get('output_path')}")
                self._load_manifest_from_path(self.current_manifest_path)
                handled = True
                continue

            if event == "regen_error":
                self.progress.stop()
                self._append_log("[重生成失败]")
                self._append_log(str(payload.get("traceback", "")).strip())
                messagebox.showerror("重生成失败", "请查看日志定位。")
                handled = True
                continue

            self.events.put((event, payload))

        if not handled:
            self.root.after(120, self._poll_regen_events)

    def _export_log(self) -> None:
        path = filedialog.asksaveasfilename(title="导出日志", defaultextension=".log", filetypes=[("Log", "*.log"), ("Text", "*.txt")])
        if not path:
            return
        text = self.log_box.get("1.0", "end")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        messagebox.showinfo("导出成功", f"已保存到:\n{path}")


def main() -> None:
    if tk is None:
        raise RuntimeError("当前 Python 环境缺少 tkinter，请在支持 tkinter 的环境中运行。")
    root = tk.Tk()
    app = TikTokFaceReplaceApp(root)
    root.mainloop()


if __name__ == "__main__":
    mp.freeze_support()
    main()
