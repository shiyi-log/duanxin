# ESP32-C3 WiFi 转发宝固件

本仓库包含一套面向 ESP32-C3 的 ESP-IDF 固件重写工程，目标版本为 ESP-IDF `v5.5.1`。源码位于 [`esp32c3_firmware/`](./esp32c3_firmware/)，不包含设备 Flash 备份、本机配置或构建产物。

## 功能概览

- USB Serial/JTAG 维护控制台，可在 Wi-Fi 初始化前进入。
- NVS 双槽配置存储，带版本和 CRC 校验；启动时不会自动擦除 NVS。
- 启动故障保护、USB 安全模式、双 OTA 应用分区及启动回滚。
- AP+STA 网络、SPIFFS 配置页面、WebSerial 本地维护面板、配置导入导出和认证 OTA。
- ML307A UART 默认禁用。确认开发板引脚、控制脚和波特率之前，不应启用蜂窝消息功能。

## 快速构建

安装 ESP-IDF `v5.5.1` 后，在 ESP-IDF PowerShell 中从仓库根目录执行：

```powershell
cd .\esp32c3_firmware
idf.py set-target esp32c3
idf.py menuconfig
idf.py build
```

构建前需在 `menuconfig` 的 **WiFi Forwarder** 菜单设置配置 AP 密码（至少 8 个字符）和 Web 管理员密码（至少 12 个字符）。请勿将真实凭据提交到仓库或写入共享日志。

## 技术文档

完整的环境准备、构建验证、维护协议、分区表和恢复说明见 [`esp32c3_firmware/README.md`](./esp32c3_firmware/README.md)。

## 安全边界

原固件配置不会迁移，刷入新固件后需重新录入 Wi-Fi、手机号及业务配置。原始整片 Flash 镜像可能包含设备数据，应仅在本地私下保管。烧录前须核对分区和镜像大小，并验证 USB 恢复、AP 行为及 OTA 回滚。
