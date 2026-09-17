# Relay — 自托管 AI 对话 + 中转服务

一个单容器部署的 Web 聊天服务：

- 默认端口 **8511**（可通过 `HOST_PORT` 环境变量修改宿主机映射端口）
- **首个注册的账号自动成为管理员**
- 支持配置 **OpenAI** 或 **Claude (Anthropic)** 的 API Key，二选一或都配置
- **模型列表实时从 OpenAI / Claude 官方接口拉取**，配置密钥后自动显示账号下所有可用的对话模型，无需手动维护列表
- **支持图片输入**：composer 里可以点击回形针上传图片，或直接粘贴截图，发送给支持视觉理解的模型
- **代码渲染**：回复中的代码块会自动高亮、带一键复制按钮，适合日常写代码 / debug 场景
- 界面参考 Claude.ai 的深色简约风格
- 同时对外提供一个 **OpenAI 兼容的中转（relay）接口**，可以被其他设备 / 程序远程调用，
  相当于把这台服务当成你自己的 API 网关，不必把真实密钥分发出去

## 快速开始（Docker Compose，推荐）

```bash
cp .env.example .env   # 可选，修改 HOST_PORT
docker compose up -d --build
```

打开 `http://<你的服务器IP>:8511`，第一个注册的账号即为管理员。

## 快速开始（纯 Docker）

```bash
docker build -t ai-relay .
docker run -d --name ai-relay \
  -p 8511:8511 \
  -v $(pwd)/data:/app/data \
  ai-relay
```

## 数据持久化

账号、对话记录（文字）、密钥都保存在容器内的 `/app/data/db.json`（通过挂载的 `./data` 目录持久化），
无需额外数据库。图片走单独的、带自动过期的存储（见下），不会进这个 JSON 文件。删除 `./data` 目录即可完全重置服务。

## 配置 API Key

登录后点击左下角头像 → **设置**：

- **API 密钥** 标签页：填写你个人的 OpenAI / Claude 密钥，仅对你自己的账号生效，优先于管理员的全局密钥。
- **管理员** 标签页（仅管理员可见）：填写全局 OpenAI / Claude 密钥，供未单独配置密钥的成员账号使用；
  也可以在这里开关"开放注册"、管理成员账号、设置图片保留天数。

两个服务商可以只配置一个，也可以同时配置。配置完成后，点击顶部的模型选择按钮会弹出一个**可搜索、分类展示**的模型面板：
**实时从对应服务商拉取该账号当前可用的全部模型**，按"服务商 · 类型"分组（比如"OpenAI · 对话"、"OpenAI · 图像生成"、"Claude · 对话"），
每个模型都带一句简介和一个能力标签（旗舰 / 推理 / 轻量 / 均衡 / 图像），输入关键字可以直接筛选。
不需要在代码里手动维护型号列表，新模型上线后重新打开一次设置即可用上（模型列表会缓存 10 分钟以减少请求）。

## 图片、图像生成与代码

- composer 左侧的 📎 按钮可以上传图片，也可以直接把截图粘贴进输入框，最多同时附带 6 张（单张不超过 8MB）；
  发送后会连同文字一起交给当前选中的模型理解（前提是该模型支持视觉输入 —— 目前 OpenAI 和 Claude 主力模型基本都支持）。
- **选择"图像生成"分类下的模型**（比如 `gpt-image-2`）时，composer 的行为会变成生图/改图：
  - 只输入文字 → 按文生图（调用 OpenAI 的 `/v1/images/generations`）
  - 附带一张或多张参考图 + 文字指令（比如"改为黑色"）→ 按图编辑（调用 `/v1/images/edits`），会把上传的图作为参考图交给模型重新生成
  - 生成结果直接以图片形式显示在对话里，可点击预览/下载。目前图像生成仅支持 OpenAI（Claude 没有生图接口）。
  - 选中图像生成模型后，顶部会出现一个"⚙️ 生成设置"按钮，可以设置：
    - **尺寸**：自动 / 1024×1024（方形）/ 1536×1024（横向）/ 1024×1536（竖向）/ 自定义（`宽x高`，需模型支持任意分辨率，如 `gpt-image-2`）
    - **质量**：自动 / 低 / 中 / 高 / 超高 / 最高——**质量是影响费用最主要的参数**，图越精细、耗费的图像 token 越多，先用"低"试跑没问题再调高
    - **数量**：一次生成几张（1–10），会线性叠加费用
    - **格式**：PNG / JPEG / WebP
    - **背景**：自动 / 不透明 / 透明（仅对支持透明背景的格式有意义）
    
    这些设置保存在每个对话上，不同对话可以用不同的参数；对应到 OpenAI 官方接口的 `size` / `quality` / `n` / `output_format` / `background` 字段，
    未设置的字段不会传给 OpenAI，由其自行使用默认值。
- **图片不会塞进 `db.json`、也不会无限占用磁盘**：上传后只写一份临时文件（用于事后在聊天记录里预览/下载），
  聊天界面里显示的是一个 `/api/images/...` 链接（需要登录、且只有本人能访问），而不是把图片编码进接口响应里。
  这些临时文件按管理员设置的"图片自动清理（天）"（默认 3 天）自动删除，改成 0 则表示**模型用完这张图后立即删除，不再支持事后预览/下载**——
  纯粹只是"发给模型看一眼"，不留痕迹。服务每 6 小时还会顺带清一次没有任何消息引用的孤儿文件。
- 通过 `/v1` 中转接口（见下）调用时，图片全程只在内存里转发给上游模型，**完全不落盘、不写数据库**——因为
  中转接口本身就是无状态的，不保存任何对话记录，这条路径天生就没有占空间的问题。
- 回复中的代码块会自动语法高亮并带"复制"按钮，方便直接粘出去用。

## 作为中转接口远程调用

在 **设置 → 中转访问** 标签页可以看到：

- **Base URL**：`http://<你的服务器>:8511/v1`
- **你的中转密钥**：形如 `rk-xxxxxxxx`，可随时重新生成（旧密钥立即失效）

任何支持自定义 `base_url` 的 OpenAI 兼容客户端（包括 OpenAI 官方 SDK、各类第三方工具）都可以直接指向这个地址，
用中转密钥代替真实的 OpenAI / Claude 密钥。中转接口覆盖三个能力，都是 OpenAI 官方 SDK 能直接调用的标准路径：

- `POST /v1/chat/completions` —— 对话（含视觉输入）。服务会根据你请求的 `model` 名称自动路由到 OpenAI 或 Claude
  （也可以在请求体里显式传 `"provider": "openai"` 或 `"provider": "claude"` 来覆盖自动判断，适合自定义/微调模型名的场景），
  并统一以 OpenAI 的响应格式返回（包括流式响应、以及图片输入的 `image_url` 格式，会被自动转换成 Claude 需要的格式）。
- `POST /v1/images/generations` —— 文生图（对应 SDK 里的 `client.images.generate()`），支持 `size` / `quality` / `n` / `output_format` / `background` 参数。
- `POST /v1/images/edits` —— 图片编辑，multipart 上传，`image` 或 `image[]` 字段（对应 SDK 里的 `client.images.edit()`），同样支持上面这些参数。
- `GET /v1/models` —— 除了标准的 `id`/`owned_by` 字段，额外带了 `category`（`chat`/`image`）、`tier`（旗舰/推理/轻量/均衡/图像）、
  `description` 三个字段，方便你在自己的客户端里也做分类和搜索。

示例：

```bash
# 对话
curl http://<你的服务器>:8511/v1/chat/completions \
  -H "Authorization: Bearer rk-你的中转密钥" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": false
      }'

# 文生图，控制尺寸/质量/数量
curl http://<你的服务器>:8511/v1/images/generations \
  -H "Authorization: Bearer rk-你的中转密钥" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-image-2",
        "prompt": "一只戴墨镜的柴犬，插画风格",
        "size": "1024x1024",
        "quality": "low",
        "n": 1
      }'

# 图片编辑，同样可以带这些参数
curl http://<你的服务器>:8511/v1/images/edits \
  -H "Authorization: Bearer rk-你的中转密钥" \
  -F "model=gpt-image-2" \
  -F "prompt=把包的颜色改成黑色" \
  -F "quality=medium" \
  -F "image[]=@bag.png"
```

可用模型以 `GET /v1/models`（同样用中转密钥鉴权）返回的实时列表为准，覆盖账号下配置了密钥的服务商当前提供的所有模型
（对话、推理、视觉理解、图像生成等各类型号），不局限于固定的几个。

> 提示：把服务部署在具备公网 IP / 域名的主机上，并建议加一层 HTTPS 反向代理（如 Nginx、Caddy）
> 后再对外开放，避免中转密钥在明文 HTTP 下传输。

## 目录结构

```
ai-relay/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js          # Express 入口
│   ├── db.js              # JSON 文件存储
│   ├── auth.js             # 登录鉴权
│   ├── routes/
│   │   ├── auth.js         # 注册/登录/登出
│   │   ├── settings.js     # 个人设置 + 管理员设置
│   │   ├── chat.js         # 会话与流式对话
│   │   ├── images.js       # 带鉴权的图片预览/下载 (/api/images/:filename)
│   │   └── relay.js        # 对外的 OpenAI 兼容中转接口 (/v1，含对话 + 图像生成/编辑)
│   └── services/
│       ├── providers.js    # OpenAI / Claude 上游调用、流式解析、模型分类与简介、图像生成
│       ├── keys.js         # 密钥优先级解析
│       ├── images.js       # 图片临时文件的读写（不进 db.json）
│       ├── cleanup.js      # 按保留天数清理过期图片 + 清理孤儿文件
│       └── network.js      # 可选的出站代理支持（HTTPS_PROXY）
└── public/                # 前端静态页面
```

## 排查"填了密钥但读取不到模型"

顶部模型下拉框现在会把具体报错显示在下拉框下方（不再是笼统的"暂无可用模型"），先看这条提示：

- **提示是 401 / invalid api key 之类** —— 密钥本身不对，或者复制的时候带了多余的空格/换行，重新粘贴一遍。
- **提示是 403 Forbidden**（尤其是不带 Authorization 头的裸请求也返回 403，而不是"缺密钥"该有的 401）——
  这基本可以确定**不是密钥问题，是 OpenAI / Anthropic 在請求到达你的密钥校验之前，就已经在网络层拒绝了这台服务器的 IP**，
  常见于云服务器（AWS/GCP 等）所在的地区被判定为 OpenAI 的"不支持的国家/地区"（`unsupported_country_region_territory`），
  和你的账号、密钥是否有效完全无关。
- **提示是 fetch failed / timeout**，或者压根没有任何提示但模型一直是空的 —— 大概率是这台服务器**根本连不通**这两个域名（DNS 或防火墙层面）。

不管是哪种网络层的拒绝，解法都是让请求从一个 OpenAI/Anthropic 认可的出口出去，两种方式任选：

1. **通用代理**：在 `.env` 里配
   ```
   HTTPS_PROXY=http://你的代理地址:端口
   ```
   `docker compose up -d --build` 重启后，发往 OpenAI/Claude 的请求都会自动走这个代理。
2. **换一个可用的接口地址**：如果你有一个自己可控的反向代理/镜像站点，且返回的数据和官方接口格式完全一致，可以直接换掉请求的地址，不用配代理：
   ```
   OPENAI_BASE_URL=https://你的-openai-镜像地址
   ANTHROPIC_BASE_URL=https://你的-anthropic-镜像地址
   ```

也可以直接进容器测一下，区分是网络层问题还是别的：
```
docker exec -it ai-relay wget -qO- https://api.openai.com/v1/models
docker exec -it ai-relay wget -qO- https://api.anthropic.com/v1/models
```
没带密钥的裸请求，OpenAI/Anthropic 正常应该回 401（说明网络通、只是缺密钥），如果回的是 403 或者卡住/连不上，就是上面说的网络层问题，配好代理或镜像地址后同一台机器上正常应该就能跑通了。

## 安全提示

- 请修改默认端口 / 加防火墙规则，避免管理注册页直接暴露公网。
- 中转密钥（`rk-...`）等同于账号凭证，请勿提交到公开仓库或分享给不信任的第三方。
- 生产环境建议放在反向代理后并启用 HTTPS。
