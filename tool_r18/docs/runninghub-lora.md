# RunningHub LoRA 接入

本项目的工作流人设 LoRA 放在本机：

```text
C:\Users\14471\Downloads\模型
```

已接入的本地别名：

| personaKey | LoRA 文件 |
| --- | --- |
| `jinjunya` | `人设1捞女1金君雅.safetensors` |
| `xiangwanwan` | `人设2捞女2向晚晚.safetensors` |
| `xiaomii` | `人设3捞女小mi.safetensors` |
| `f1` | `人设6电竞女芙依F1 .safetensors` |
| `jason` | `人设7电竞男jason.safetensors` |
| `cute_jp` | `人设4日系可爱.safetensors` |
| `yoga` | `人设5瑜伽老师.safetensors` |
| `aunt50` | `50岁阿姨.safetensors` |
| `detail_daemon` | `REDZ15_DetailDaemonZ_lora.safetensors` |
| `breast_slider` | `胸部Z-Breast-Slider.safetensors` |
| `hip_slider` | `臀部Z-Hip-Slider.safetensors` |

先扫描本地 LoRA，不上传：

```bash
npm run skill:runninghub-lora -- '{"action":"inventory","modelDir":"C:\\Users\\14471\\Downloads\\模型"}'
```

配置 RunningHub 后上传：

```json
{
  "runningHubKey": "your-runninghub-api-key",
  "runningHubEndpoint": "https://www.runninghub.ai",
  "runningHubWorkflowId": "your-workflow-id"
}
```

然后执行：

```bash
npm run skill:runninghub-lora -- '{"action":"upload","modelDir":"C:\\Users\\14471\\Downloads\\模型"}'
```

上传结果会写入：

```text
.runtime/automatic-script/runninghub-lora-map.json
```

给 RunningHub `RHLoraLoader` 生成 nodeInfo：

```bash
npm run skill:runninghub-lora -- '{"action":"node-info","personaKey":"jinjunya","loraNodeId":"105"}'
```

如果 RunningHub 工作流里的 LoRA 节点字段不是 `lora_name`，传入 `loraFieldName` 覆盖。

如果 LoRA 已经在 RunningHub 后台手动上传过，也可以直接传返回的文件名：

```bash
npm run skill:runninghub-lora -- '{"action":"node-info","personaKey":"jinjunya","loraNodeId":"105","runningHubFileName":"your-runninghub-lora-file-name"}'
```

将本地 ComfyUI 工作流转换为 RunningHub LoRA 版本：

```bash
npm run skill:runninghub-workflow-map -- '{"workflowDir":"C:\\Users\\14471\\Downloads\\数字人"}'
```

转换后的工作流输出到：

```text
output/runninghub-workflows
```

转换规则：

- 能匹配到本地 LoRA 的 `LoraLoader` 会改成 `RHLoraLoader`
- 能匹配到本地 LoRA 的 `LoraLoaderModelOnly` 会改成 `RHLoraLoaderModelOnly`
- `widgets_values[0]` 会替换成 RunningHub 上传返回的 `api-lora-cn/...safetensors`
