# ESP32-C3 WiFi 转发宝固件技术说明

本目录是基于 ESP-IDF 的独立固件工程。目标芯片为 ESP32-C3，目标 ESP-IDF 版本为 `v5.5.1`。原始固件配置不会自动迁移到新固件。

## 功能与状态

- USB Serial/JTAG 维护控制台在 Wi-Fi 初始化前可用。
- 配置使用带版本号和 CRC 校验的 NVS 双槽存储；启动流程不会自动擦除 NVS。
- 连续启动失败保护和 USB 安全模式用于故障恢复。
- 初次启动约 10 秒后广播 `SMS-Forwarder-AP` 供配网；STA 成功连接上游 Wi-Fi 后关闭 AP，已配置设备后续失去上游 Wi-Fi 时广播 `ESP32-AP-xxxxxx` 恢复入口。
- SPIFFS 提供配置页面；支持本地 WebSerial 维护、配置导入导出和带认证的 OTA 上传。
- 使用双应用分区，并启用 bootloader 应用回滚。
- ML307A UART 传输默认关闭。当前尚未验证开发板 UART 引脚、控制引脚和波特率；确认硬件参数前不得启用蜂窝消息或通知功能。

## 安全配置

新固件不会迁移原固件中的 Wi-Fi、手机号或业务配置。首次启动不会自动把默认模板标记为已初始化；设备会保持 USB 维护通道可用，并在启动约 10 秒后提供配网 AP。通过配网 AP 访问页面时，安全恢复模式只开放配置读取、Wi-Fi 扫描和配置写入/保存，且要求客户端来自设备 AP 子网。AP 与网页密码应设置为强口令；若编译配置中没有 AP 密码，初次配网 AP 会开放广播，附近人员可能连接，因此建议先用 USB 完成初始化或在本地构建时设置 AP 密码。

构建前在 `idf.py menuconfig` 的 **WiFi Forwarder** 菜单配置两项不同的本地密钥：

- 配置 AP 密码：至少 8 个字符。
- Web 管理员密码：至少 12 个字符。

未设置密钥时，固件保持在 USB 维护模式，直到完成配置。不要把真实凭据写入仓库、`sdkconfig`、测试数据或共享日志。仓库忽略本地生成的 `sdkconfig` 和构建目录。

## 使用与法律合规

使用者必须遵守设备所在地、部署地及通信服务适用的法律法规。严禁将本项目源码、固件或衍生工具用于任何违法活动，包括未经授权访问或控制设备、网络及第三方系统，非法截取或披露通信内容和个人信息，发送诈骗、骚扰或垃圾信息，或干扰他人通信与公共服务。仅可在自有设备或已获得明确授权的设备和网络上进行测试；使用者须自行确认授权范围并对部署和使用行为负责。本项目不授予访问任何设备、网络或通信数据的权限。

本节是项目合规政策提醒，不是法律意见，也不保证在所有司法辖区自动构成可执行的合同条款。仓库目前未附单独的软件许可证；公开托管不等于已明确授予代码复用、修改和再分发权利。按用途限制合法使用也可能与 [OSI 开源定义](https://opensource.org/osd) 不兼容；如需正式许可条款，应先确定许可证并进行法律审阅。

## 环境与构建

使用 ESP-IDF `v5.5.1`。如果通过 ESP-IDF Installation Manager 安装在默认目录，可在 ESP-IDF PowerShell 中加载生成的环境配置脚本：

```powershell
. 'C:\Espressif\tools\Microsoft.v5.5.1.PowerShell_profile.ps1'
```

若安装位置不同，请调整脚本路径。完成环境加载后，从仓库根目录执行：

```powershell
cd .\esp32c3_firmware
idf.py set-target esp32c3
idf.py menuconfig
idf.py build
```

执行 `idf.py build` 后，烧录前先检查生成的分区表和应用镜像大小。未验证应用大小、AP 行为、USB 恢复路径及 OTA 回滚前，不要向设备烧录。

## 自动化测试

在本目录运行契约测试：

```powershell
python -m unittest discover -s tests -p "test_*.py"
node --test tests/webserial_teardown.test.js
```

这些测试检查分区布局、关键启动配置、恢复约束和 WebSerial 连接清理逻辑；通过测试不等同于已在实体设备上完成验证。

设备处于首次初始化安全模式且电脑已连接设备 AP 时，可额外运行只读 HTTP 冒烟测试：

```powershell
$env:ESP32_TEST_BASE_URL = "http://192.168.4.1"
python -m unittest discover -s tests -p "test_live_device_http.py"
Remove-Item Env:ESP32_TEST_BASE_URL
```

该测试核对设备页面资源与工作区是否一致、状态/配置脱敏、Wi-Fi 扫描和未授权请求拒绝；扫描只改变当前运行中的无线模式，不保存配置或重启设备。

## USB 维护

通过设备的 USB Serial/JTAG COM 端口以 `115200` 波特率连接。常用文本命令如下：

```text
help
status
logs
config show
config set wifi_ssid MyNetwork
config set wifi_password MyPassword
config save
reboot
```

示例中的 `MyNetwork` 和 `MyPassword` 是占位值，请勿直接用于真实网络。

控制台也支持逐行 JSON 请求。请求示例：

```json
{"v":1,"id":"1","op":"status"}
```

响应以 `@` 开头，并回传相同的 `id`。支持的操作包括 `status`、`logs`、`wifi.scan`、`config.get`、`config.set`、`config.clear`、`config.save`、`config.import`、`config.export`、`config.reset`、`ota.status`、`ota.rollback`、`recovery.clear` 和 `reboot`。

### USB 维护烟测

在 Windows PowerShell 中运行以下命令，可检查 USB 状态、密钥脱敏、日志崩溃特征、OTA 状态、帮助响应和输入拒绝路径：

```powershell
.\tests\test_live_device_usb.ps1 -PortName COM3
```

该脚本会发送必然被拒绝的超长 SSID、非法心跳数字、溢出值和负数 `config.set` 请求，并核对配置未变化；不会调用 `config.save`，也不执行 Wi-Fi 扫描、复位或 OTA 操作。

## 本地初始化与 WebSerial 面板

在本目录启动本地维护面板：

```powershell
python .\tools\usb_panel\serve.py
```

然后在桌面版 Chrome 或 Edge 打开 `http://127.0.0.1:8765/`。默认显示初始化/故障恢复向导；扫描已授权 USB 设备，首次使用通过浏览器弹窗授权。初始化保存成功后，页面切换到正式管理端。服务仅绑定本机回环地址，页面由本机提供，无需互联网连接。

手机配网时，连接设备广播的 AP 并在浏览器打开 `http://192.168.4.1/`。已连接上游 Wi-Fi 后，设备会关闭 AP；后续上游 Wi-Fi 断开时，设备使用 `ESP32-AP-` 加设备 MAC 末三字节十六进制后缀重新广播。

## 分区布局

分区定义见 [`partitions.csv`](./partitions.csv)：

| 分区 | 偏移 | 大小 | 用途 |
| --- | ---: | ---: | --- |
| `nvs` | `0x9000` | `0x5000` | 配置与设备状态 |
| `otadata` | `0xE000` | `0x2000` | OTA 启动选择数据 |
| `app0` | `0x10000` | `0x140000` | OTA 应用槽 0 |
| `app1` | `0x150000` | `0x140000` | OTA 应用槽 1 |
| `storage` | `0x290000` | `0x160000` | SPIFFS 页面资源 |
| `coredump` | `0x3F0000` | `0x10000` | 崩溃转储 |

## 恢复限制

应用控制台可恢复配置、网络和失败的 OTA 更新。如果两个应用槽都不可用，或 ROM USB 下载路径失效，ESP32-C3 ROM 下载模式仍可能要求在复位时操作实体启动绑带。固件无法保证从损坏的启动路径恢复。原始整片 Flash 备份可能含 Wi-Fi 凭据、电话号码及业务数据，必须仅在本地私下保管，不要上传到公开仓库。
