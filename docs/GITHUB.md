# GitHub 仓库与云端编译 — 操作手册

> 前置状态：`E:\MyEsp32` 已完成 git 初始化和首次提交（`f830a07`，301KB），
> `.gitignore` 已排除 vendor-demo（176MB）、node_modules、config.json。
> 你只需要做下面 5 步。

---

## 步骤 1：在 GitHub 网页上建一个**空**仓库

1. 打开 <https://github.com/new>（登录后）
2. 填写：
   - **Repository name**：`myesp32`（随意，下面以这个为例）
   - **Public**（推荐）：公共仓库 Actions 免费不限时；Private 有每月 2000 分钟限额
3. ⚠️ **三个勾选框全部不勾**：
   - ~~Add a README file~~
   - ~~Add .gitignore~~
   - ~~Choose a license~~

   **必须建空仓库**，否则远程有提交，本地推不上去。
4. 点 **Create repository**
5. 建好后页面会显示仓库地址，形如：
   ```
   https://github.com/你的用户名/myesp32.git
   ```

---

## 步骤 2：本地推送（首次会弹浏览器授权）

打开命令行（PowerShell 或 Git Bash）：

```bash
cd E:\MyEsp32
git remote add origin https://github.com/你的用户名/myesp32.git
git push -u origin main
```

**首次 push 会弹出 "Git Credential Manager" 窗口**：

1. 选 **Browser**（浏览器登录）
2. 点 **Sign in with your browser**
3. 浏览器打开 GitHub 授权页 → 点 **Authorize**
4. 回到命令行，开始上传

看到类似下面这样就成功了：

```
Writing objects: 100% (60/60), 300 KiB | 200 KiB/s, done.
Branch 'main' set up to track remote branch 'main' from 'origin'.
```

> 授权一次后凭据会保存，以后 push 不再弹窗。
> 如果弹窗没出现（比如远程连接慢），等一下；或改用 Personal Access Token（见文末）。

---

## 步骤 3：触发云端编译

1. 打开 `https://github.com/你的用户名/myesp32`
2. 点顶部 **Actions** 标签
3. 如果看到黄色提示条 *Workflows aren't being run on this forked repository*
   （新仓库一般不会，fork 的仓库会）→ 点
   **I understand my workflows, go ahead and enable them**
4. 左侧列表选 **Build MyEsp32 Firmware**
5. 由于 `build.yml` 监听了 push 且 `firmware/` 有文件，**push 后应该已经自动跑起来了**
   如果没有，右侧 **Run workflow** → 选 `main` → **Run workflow**
6. 点进这次运行，等它跑完（**首次 10~20 分钟**，要下载工具链缓存 + 拉组件依赖）

成功标志：左侧圆点变 **绿色 ✓**

---

## 步骤 4：下载固件

1. 点进那次成功的运行（绿 ✓ 的）
2. 拉到页面最底部 **Artifacts** 区域
3. 下载 **`myesp32-merged`**
4. 解压 zip，得到 **`merged-binary.bin`**（约 2MB）和 `flash_args`

> 如果还有 `myesp32-bins`，那是分文件版本，备用，一般用不到。

---

## 步骤 5：烧录

把解压出的文件放到任意位置，然后：

```bash
cd E:\MyEsp32
flash.bat "C:\Users\你\Downloads\merged-binary.bin" COM3
```

- 第一个参数是固件路径（有空格要加引号）
- 第二个是 COM 口（设备管理器 → 端口 里看，不确定就用 COM3 试）

脚本会：**全擦 Flash → 烧 merged-binary.bin → 重启**

> 烧录前不用按 BOOT——这块板用原生 USB-Serial/JTAG，esptool 自动复位。
> 连不上时再按住 BOOT、点一下 RESET、松开。

---

## 步骤 6：验证

插着 USB，开串口终端（115200）。预期日志：

```
I (xxx) sensors: I2C + ADC 就绪
I (xxx) main: MyEsp32 0.1.0 启动
I (xxx) wifi: WiFi 启动，连接 MyWiFi
I (xxx) wifi: IP: 192.168.1.xxx
I (xxx) ws: 已连接服务器        ← 服务器开着才会出现
```

屏幕预期：

| 区域 | 内容 |
|---|---|
| 左半 | 大头警察（idle，每 3 秒眨眼） |
| 右上 | 大号 7 段时钟（如果连上服务器，时间是准的；没连显示 `--:--`） |
| 右中 | 日期 `10/18 SUN`、天气图标+温度、室温、湿度、电量 |
| 按 KEY | 切到 "Coming Soon"，5 秒后回主页 |

**注意**：WiFi SSID/密码目前是编译期配置（默认 `MyWiFi` / 空密码）。
要改成你家的 WiFi，改 `firmware/components/net/Kconfig.projbuild` 里的 default 值，
或者用 menuconfig，改完 push 重新编译。SoftAP 配网是 M7 的事。

服务器没开也没关系——板子会显示 `--:--`，其他本地信息（温湿度/电量）照常显示。

---

## 常见问题

| 现象 | 原因与解法 |
|---|---|
| push 报 `403` | 授权失败。重试 push；或在 GCM 窗口选 Browser 重登 |
| push 报 `rejected (fetch first)` | 建仓时勾了 README。执行 `git pull --rebase origin main` 再 `git push` |
| push 卡住不动 | 网络问题。重试；或换热点 |
| Actions 里找不到工作流 | `.github/workflows/build.yml` 没推上去。检查 `git ls-files | grep workflows` |
| 编译失败 | 点进失败的 run，把红色日志第一段贴给我 |
| 没有生成 artifact | 编译失败，同上 |
| 烧录报 `Failed to connect` | 换数据线 / 按 BOOT+RESET 进下载模式 / 确认 COM 口 |
| 屏幕花屏/镜像/全黑 | 极性或映射偏差，发截图给我，改 lcd.c 一处即可 |

---

## 附：用 Personal Access Token 推送（可选，GCM 不弹窗时的替代）

1. GitHub → 右上角头像 → **Settings** → **Developer settings** →
   **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
2. 勾选 **repo** 权限，生成后复制（只显示一次）
3. push 时把 token 当密码用：
   ```bash
   git push -u origin main
   # Username: 你的用户名
   # Password: 粘贴 token
   ```
