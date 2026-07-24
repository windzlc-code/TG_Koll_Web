import fs from "node:fs";
import path from "node:path";

function parseJsonObjectWithTrailingRepair(raw = "") {
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch (error) {
    const first = raw.indexOf("{");
    if (first < 0) throw error;
    let inString = false;
    let escaped = false;
    let depth = 0;
    for (let index = first; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const value = JSON.parse(raw.slice(first, index + 1));
          return { value, repaired: raw.slice(index + 1).trim().length > 0 };
        }
      }
    }
    throw error;
  }
}

export class JsonConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.loaded = false;
  }

  load(force = false) {
    if (this.loaded && !force) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const { value: parsed, repaired } = parseJsonObjectWithTrailingRepair(raw);
      this.data = parsed && typeof parsed === "object" ? parsed : {};
      if (repaired) this.save();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      this.data = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, this.filePath);
    } finally {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // The rename already removed the temporary file on the normal path.
      }
    }
  }

  get(key) {
    this.load(true);
    return this.data[key];
  }

  set(key, value) {
    // Python and the browser-auth endpoint also update this file. Always merge
    // into the latest on-disk document instead of restoring the startup cache.
    this.load(true);
    this.data[key] = value;
    this.save();
  }

  all() {
    this.load(true);
    return { ...this.data };
  }
}
