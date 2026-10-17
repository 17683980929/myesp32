# MyEsp32 — 项目方案

> 自研固件 + 自建服务器的 ESP32-S3 桌面宠物
>
> 状态：方案待确认　｜　最后更新：2026-10-18

---

## 一、目标

在 Waveshare ESP32-S3-RLCD-4.2 上做一台**自己的**桌面宠物：

- 屏幕左侧是大头警察桌宠，右侧是时间/日期/天气/温湿度/电量
- 能语音对话（借鉴小智的思路，但服务器完全自己写）
- 板子上嵌 **Lua 解释器**，可以随时通过网络下发脚本，把已有积木重新组合
- 所有重计算（ASR / LLM / TTS）都在云端，后端可配置
- 后端提供配置网页，在线改板子参数

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  ESP32-S3-RLCD-4.2（自研固件）                                │
│                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────────┐   │
│  │ 显示     │ │ 音频     │ │ 按键     │ │ Lua 解释器        │   │
│  │ ST7305  │ │ ES8311  │ │ KEY=18  │ │ espressif/lua    │   │
│  │ 400×300 │ │ ES7210  │ │ BOOT=0  │ │ 白名单 API        │   │
│  │ 1bpp    │ │ I2S     │ │         │ │                  │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────────┬─────────┘   │
│       └───────────┴───────────┴───────────────┘             │
│                        │                                    │
│              ┌─────────▼─────────┐                          │
│              │ 协议层 WebSocket   │                          │
│              │ JSON + Opus 二进制 │                          │
│              └─────────┬─────────┘                          │
└────────────────────────┼────────────────────────────────────┘
                         │  WiFi 2.4G
┌────────────────────────▼────────────────────────────────────┐
│  Node.js 服务器（自建）                                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ WS 设备网关   │  │ 配置网页      │  │ 云端服务封装      │   │
│  │ 协议解析      │  │ /admin       │  │ ASR / LLM / TTS  │   │
│  │ 会话管理      │  │ 板子参数      │  │ 天气             │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                             │
│  配置存 config.json　｜　日志存 logs/                        │
└─────────────────────────────────────────────────────────────┘
                         │ HTTPS
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   腾讯云 ASR       DeepSeek LLM       TTS 引擎
```

**关键设计：板子不直接联外网。** 天气、时间同步、模型调用全由服务器代理，
板子只需要连服务器一条 WebSocket。这样：

- 板子端代码简单、RAM 占用小
- 换模型/换 TTS/换天气源都不用动固件
- 只有一条出网连接，好排查

---

## 三、硬件资源清单（已确认）

### 主控

| 项目 | 规格 |
|---|---|
| 芯片 | ESP32-S3-WROOM-1-N16R8 |
| Flash | 16 MB (QIO 80MHz) |
| PSRAM | 8 MB (Octal 80MHz) |
| MAC | 44:b1:76:a3:2b:f4 |

### 显示屏（ST7305 反射式单色）

| 项目 | 值 |
|---|---|
| 分辨率 | 400 × 300（横屏） |
| 色深 | 1 bpp（单色） |
| 帧缓冲 | 400×300/8 = **15,000 字节** |
| 总线 | SPI3 |
| MOSI | GPIO12 |
| SCK | GPIO11 |
| CS | GPIO40 |
| DC | GPIO5 |
| RST | GPIO41 |
| TE | GPIO6（软件未使用） |

### 音频

| 项目 | 值 |
|---|---|
| DAC | ES8311（I2C 0x18） |
| ADC | ES7210（I2C 0x40，双麦 + 参考通道） |
| I2S MCLK | GPIO16 |
| I2S BCLK | GPIO9 |
| I2S WS | GPIO45 |
| I2S DIN（麦） | GPIO10 |
| I2S DOUT（喇叭） | GPIO8 |
| 功放使能 | GPIO46 |

### I2C 总线（SDA=13, SCL=14）

| 设备 | 地址 | 用途 |
|---|---|---|
| ES8311 | 0x18 | 音频 DAC |
| ES7210 | 0x40 | 音频 ADC |
| PCF85063 | 0x51 | RTC 实时时钟 |
| **SHTC3** | **0x70** | **温湿度** |

### 按键

| 按键 | GPIO | 有效电平 | 用途 |
|---|---|---|---|
| **KEY** | **18** | 低 | **主页 ↔ 功能页**（需求 C） |
| BOOT | 0 | 低 | 备用（配网 / 强制下载） |
| PWR | — | 硬件电路 | 长按关机，单击开机 |

### 电池

| 项目 | 值 |
|---|---|
| 检测 | ADC1_CH3，电压 ×3 换算 |
| 电量公式 | `(-v² + 9016v - 19189000)/10000`，v 单位 mV |
| 充电状态 | ❌ 硬件未引出，无法检测（仅 CHG 指示灯） |

---

## 四、屏幕布局（400 × 300）

```
┌───────────────────────────┬──────────────────────────┐
│                           │                          │
│                           │   14:32                  │  ← 时间 40px 大字号
│                           │   10月18日 周日           │  ← 日期 16px
│      桌宠区域              │   ──────────────         │  ← 分隔线
│      200 × 300            │   晴  22℃                │  ← 天气 20px
│                           │                          │
│   帧尺寸 200×267           │   室温  24.5℃            │  ← 温湿度 16px
│   垂直居中（y 偏移 16）     │   湿度  58%              │
│                           │                          │
│                           │   电量  76%              │  ← 电量 16px
│                           │                          │
└───────────────────────────┴──────────────────────────┘
0                         199 200                    399
```

**功能页**（按 KEY 进入）：

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                                                      │
│                    敬请期待                           │
│                                                      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

5 秒后自动切回主页。

### 字体方案

不自带大字体库（太占 Flash）。**自制点阵字体子集**，只包含用到的字符：

- 数字 `0-9`、`:`、`%`、`℃`、`-`、`.`
- 汉字：`年月日周一二三四五六晴多云雨阴室温湿度电量敬请期待`
- 两套字号：16px（正文）、40px（时间）

预计 60~70 个字形，16px 约 1.7KB + 40px 约 4KB，**总共不到 6KB**。
用脚本从系统字体生成 C 数组。

---

## 五、设备 ↔ 服务器协议

**传输**：WebSocket（一条长连接）
**编码**：控制消息用 JSON 文本帧，音频用二进制帧

### 设备 → 服务器

| 类型 | 格式 | 说明 |
|---|---|---|
| `hello` | `{"t":"hello","fw":"0.1.0","mac":"...","caps":["audio","lua"]}` | 连上后第一件事 |
| `btn` | `{"t":"btn","k":"key","e":"click"}` | 按键事件 |
| `lua` | `{"t":"lua","id":12,"ok":true,"out":"..."}` | Lua 脚本执行结果 |
| 音频 | 二进制帧 | Opus 16kHz 单声道 60ms |

### 服务器 → 设备

| 类型 | 格式 | 说明 |
|---|---|---|
| `hello_ack` | `{"t":"hello_ack","sid":"...","pv":1,"page":"home","info":{...}}` | 握手确认，顺带带上首帧信息 |
| `info` | `{"t":"info","time":"14:32","date":"10月18日","week":"周日","weather":{"text":"阴","temp":16}}` | **只含时间/日期/天气** |
| `page` | `{"t":"page","name":"home"}` | 服务器要求切页 |
| `tts_start` / `tts_stop` | `{"t":"tts_start"}` | 播报边界 |
| `sub` | `{"t":"sub","text":"..."}` | 当前句子（字幕） |
| `lua` | `{"t":"lua","id":12,"code":"..."}` | 下发脚本 |
| 音频 | 二进制帧 | Opus 下行 |

> **设计修正**：`info` 里**不含**温湿度/电量。这两项由板子本地读（SHTC3 在 I2C 0x70、
> 电量走 ADC1_CH3），硬件就在板上，没必要绕一圈网络。好处是断网时这四项仍然可用。
> 板子会把本地读数用 `stat` 上报给服务器，仅用于配置网页显示。

### 一次对话的时序

```
设备: 按键开始录音 → 二进制帧流式上传 → 按键结束
服务器: ASR → LLM → TTS → 二进制帧流式下发
设备: 边收边播
```

---

## 六、固件设计

### 底座：复用微雪 `10_FactoryProgram`

已解压在 `vendor-demo/`，其中可直接复用的硬件层：

| 模块 | 文件 | 复用程度 |
|---|---|---|
| 显示 | `port_bsp/display_bsp.cpp` | 复用 SPI/初始化，**渲染自己写** |
| 音频 | `port_bsp/codec_bsp.cpp` | **直接复用**（ES8311/ES7210 配置） |
| I2C | `port_bsp/i2c_bsp.cpp` | **直接复用** |
| 温湿度 | `05_I2C_SHTC3` | 移植为独立组件 |
| 电池 | `port_bsp/adc_bsp.cpp` | **直接复用** |
| 按键 | `port_bsp/button_bsp.c` | 复用（KEY=18 已在其中） |
| WiFi | `app_bsp/esp_wifi_bsp.c` | 复用 |

**不复用** `ui_bsp`（LVGL + SquareLine 生成的界面）——我们自己做 1bpp 直接帧缓冲渲染，
更省 RAM、更可控。

### 固件模块划分

```
firmware/
├── main/
│   ├── main.cpp              启动流程
│   └── app_config.h          引脚/常量
├── components/
│   ├── hw/                   硬件层（移植厂家 BSP）
│   │   ├── display_st7305.*  1bpp 帧缓冲 + 刷屏
│   │   ├── audio_codec.*     ES8311 + ES7210
│   │   ├── i2c_bus.*
│   │   ├── sensor_shtc3.*
│   │   ├── battery_adc.*
│   │   └── buttons.*         KEY=18 / BOOT=0
│   ├── ui/                   渲染层
│   │   ├── font_subset.*     点阵字体
│   │   ├── page_home.*       主页（左宠物 + 右信息）
│   │   ├── page_func.*       功能页
│   │   └── pet.*             桌宠状态机 + 帧动画
│   ├── net/                  网络层
│   │   ├── ws_client.*       WebSocket 客户端
│   │   └── protocol.*        协议编解码
│   ├── audio_pipe/           语音链路
│   │   ├── recorder.*        录音 → Opus 编码
│   │   └── player.*          Opus 解码 → 播放
│   └── lua_runtime/          Lua 解释器
│       ├── lua_host.*        初始化 + 调度
│       └── lua_api_*.c       白名单 API 注册
└── partitions.csv
```

### 内存预算（8MB PSRAM，宽裕）

| 用途 | 大小 | 位置 |
|---|---|---|
| 显示帧缓冲 | 15 KB | PSRAM |
| 桌宠帧（15 帧） | 100 KB | Flash（const） |
| 字体子集 | ~6 KB | Flash（const） |
| Opus 编解码 | ~50 KB | 内部 RAM |
| Lua 运行时 | ~40 KB | 内部 RAM |
| 音频缓冲 | ~32 KB | 内部 RAM |

---

## 七、服务器设计

### 模块

```
server/
├── src/
│   ├── index.mjs            启动
│   ├── ws-gateway.mjs       设备 WebSocket 网关
│   ├── config.mjs           配置读写（config.json）
│   ├── http-admin.mjs       配置网页 + REST API
│   ├── services/
│   │   ├── asr-tencent.mjs  腾讯云 ASR
│   │   ├── llm-deepseek.mjs DeepSeek
│   │   ├── tts.mjs          TTS（引擎可切换）
│   │   └── weather.mjs      天气（源可切换）
│   ├── session.mjs          一次对话的编排
│   └── info-pusher.mjs      定时推送信息栏数据
└── config.json
```

### 配置网页（`http://<服务器>:8080/admin`）

可在线配置：

- **板子**：设备名、MAC、允许连接的设备列表
- **WiFi**：SSID / 密码（下发给设备，或仅作记录）
- **云服务**：各服务的 Key、模型名、引擎选择
- **天气**：城市、数据源、刷新间隔
- **人设**：system prompt
- **Lua**：脚本编辑 + 一键下发到板子

### 信息栏数据流

服务器每 60 秒（可配）拉一次天气，连同时间/日期/温湿度/电量打包成 `info` 推给设备。
设备不需要自己联网取天气。

---

## 八、Lua 设计

### 运行时

用 `espressif/lua` 组件（ESP-Claw 也用这个，已验证在 ESP32 上可用）。

### 第一批暴露的 API（白名单）

```lua
-- 显示
display.clear()
display.text(x, y, "文字", size)     -- size: 16 / 40
display.rect(x, y, w, h, filled)
display.flush()                       -- 手动提交（或自动）

-- 桌宠
pet.state("thinking")                 -- idle/blink/listening/thinking/speaking/happy/sleepy/charging
pet.animate(true)

-- 传感器
sensor.temp()      --> 24.5
sensor.hum()       --> 58
sensor.battery()   --> 76
sensor.voltage()   --> 3980  (mV)

-- 系统
sys.millis()       --> 123456
sys.log("...")
sys.delay(ms)

-- 定时器
timer.after(ms, fn)
timer.every(ms, fn)
```

### 四条安全护栏（必做）

| 护栏 | 做法 |
|---|---|
| **执行超时** | 单次脚本超过 2 秒强制中断（Lua 的 debug hook 计数） |
| **内存上限** | 自定义 allocator，超过 128KB 拒绝分配 |
| **API 白名单** | 只注册上面这些，不暴露 raw GPIO / 文件系统 |
| **脚本回滚** | 保留上一版，新脚本启动失败自动回退 |

### 热更新流程

```
配置网页写脚本 → POST /api/lua/deploy → 服务器存脚本
                                        → 通过 WS 下发 {"t":"lua","code":"..."}
                                        → 设备写入 /fatfs/scripts/active.lua
                                        → 执行 → 回传结果
                                        → 失败则回滚上一版
```

---

## 九、云端编译

本地不装 ESP-IDF（网络 60KB/s，2-3GB 要 9 小时），走 GitHub Actions：

```yaml
container: espressif/idf:release-v5.5
steps:
  - idf.py set-target esp32s3
  - idf.py build
  - idf.py merge-bin -o merged-binary.bin
  - upload-artifact
```

流程：push 到 fork → 自动编译 → 下载 `merged-binary.bin` → 本地 esptool 烧到 0x0。

---

## 十、里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1** | 服务器骨架 | 能起服务、配置网页能打开、WS 能接受连接 |
| **M2** | 固件骨架 | 屏幕能点亮、能刷纯色、按键有日志、WiFi 能连上、WS 能连服务器 |
| **M3** | 主页渲染 | 左侧显示桌宠、右侧显示全部信息，数据来自服务器推送 |
| **M4** | 语音对话 | 按键说话 → 听到回答，端到端跑通 |
| **M5** | Lua 解释器 | 网页下发脚本 → 板子执行 → 屏幕有变化 |
| **M6** | 功能页 | KEY 切换 → 显示"敬请期待" → 5 秒回主页 |
| **M7** | 收尾 | CI 编译一键出固件、烧录脚本、文档齐全 |

---

## 十一、已确定的决策

| 决策项 | 选择 | 说明 |
|---|---|---|
| 天气数据源 | **wttr.in**（免注册） | 实测可用。`lang=zh` 参数不可靠（返回英文），已在服务器侧自建英文→中文映射表 |
| TTS 引擎 | **百度翻译接口**（免费） | 已验证，有限流，已做退避重试 |
| 服务器位置 | **公网云服务器** | 你的 Windows Server 2025 + Node.js 直接能跑（Node 很轻，不需要 Linux/torch） |
| WiFi 配网 | **SoftAP 配网页** | 设备开热点，手机连上填 WiFi，存 NVS |

### 公网部署必须做的两件事

因为服务器要暴露到公网，这两项**不能省**：

1. **设备鉴权 token** —— 否则任何人都能连上来用你的 DeepSeek 额度
2. **配置网页密码** —— 否则别人能直接改你的配置、看你的密钥

两个都在配置网页里设置。服务器启动时会打印警告，没设会一直提醒。

### 端口

对外只需要开 **一个端口**（默认 8080）：

- `http://<IP>:8080/admin` —— 配置网页
- `ws://<IP>:8080/device` —— 设备连接

---

## 十二、进度

| 阶段 | 状态 |
|---|---|
| **M1 服务器骨架** | ✅ **已完成并验证**（见下） |
| **M2 固件骨架** | 🟡 **代码已写完**，待云端编译验证 |
| **M3 主页渲染** | 🟡 随 M2 一起写了（等真机验证） |
| M4 语音对话 | ⬜ 服务器侧已就绪，等固件音频 |
| M5 Lua 解释器 | ⬜ |
| **M6 功能页** | 🟡 页面已写（ASCII 版），中文"敬请期待"待生成点阵 |
| M7 收尾 | ⬜（WiFi 用 menuconfig 配置，SoftAP 配网待做） |

### M2 固件（已写完，`firmware/`）

```
firmware/
├── CMakeLists.txt / partitions.csv / sdkconfig.defaults
├── main/{main.c, app_config.h}
├── components/
│   ├── hw/    lcd.c(ST7305+1bpp帧缓冲) buttons.c(KEY=18/BOOT=0) sensors.c(SHTC3+电池)
│   ├── net/   wifi_sta.c ws_client.c(esp_websocket_client) + Kconfig.projbuild
│   └── ui/    ui.c(绘制+布局+桌宠动画) font5x7.c pet_frames.c
└── .github/workflows/build.yml   ← 云端编译（espressif/idf:release-v5.5）
```

已确认的技术点：

- ST7305 初始化序列、像素映射（`index = (x/2)*75 + (299-y)/4`）、极性（bit=1 白）全部按厂家源码
- 桌宠帧 1=墨、硬件 1=白 → 全工程约定 `ink=1` 黑，blit 不取反
- 字体：自写 5x7 点阵（58 字形 406 字节），支持 1/2/3 倍放大；时钟用 7 段绘制
- 屏幕右栏用**图标+数字**（温度计/水滴/电池/天气图标程序化绘制），绕开中文字体
- 日期/星期由服务器下发数字字段（`mm/dd/wday`），设备渲染成 `10/18 SUN`

### M1 实测结果

```
[     0ms] 连接 ws://127.0.0.1:8080/device
[    12ms] ✅ 已连接
[    26ms] 📊 info  时间=00:22  10月18日 周日  天气=阴 16℃
[    27ms] ✅ hello_ack  sid=3770697c  协议版本=1  页面=home
[   517ms] → stat（模拟本地温湿度/电量）
[  1222ms] → btn key click
[  1223ms] 📄 page → func
```

已验证：WebSocket 握手、hello/hello_ack、信息栏推送（时间/日期/星期/天气）、
按键切页、天气中文映射（`Overcast` → `阴`）、配置网页可访问（13.5KB）、
`/api/config` 密钥脱敏、`/api/status` 设备列表。

### 服务器文件结构（已实现）

```
server/
├── package.json
├── config.json            运行配置（首次启动自动生成）
├── src/
│   ├── index.mjs          启动入口（HTTP + WS 同端口）
│   ├── config.mjs         配置读写 + 脱敏
│   ├── protocol.mjs       协议定义 + 时间格式化
│   ├── device.mjs         设备会话（对话链路编排）
│   ├── ws-gateway.mjs     设备网关（鉴权 + 会话管理）
│   ├── http-admin.mjs     配置网页 + REST API
│   └── services/
│       ├── weather.mjs    wttr.in + 英文→中文映射
│       ├── asr.mjs        腾讯云 Flash ASR（HMAC-SHA1）
│       ├── llm.mjs        DeepSeek 流式 + 按句切分
│       └── tts.mjs        百度 TTS + Opus 编解码
└── tools/
    └── test-device.mjs    模拟设备，验证协议
```

### 怎么跑

```bash
cd E:\MyEsp32\server
node src/index.mjs
```

然后浏览器打开 `http://127.0.0.1:8080/admin` 填配置。

模拟设备验证：

```bash
node tools/test-device.mjs --btn
```

---

## 附：目录结构

```
E:\MyEsp32\
├── PLAN.md                 ← 本文
├── assets/
│   └── pet_frames/         桌宠 15 帧（200×267 1bpp，100KB）
├── firmware/               固件工程（ESP-IDF）
├── server/                 Node.js 服务器
├── web/                    配置网页
├── docs/                   文档
└── vendor-demo/            微雪官方 demo（参考资料，不进 git）
```
