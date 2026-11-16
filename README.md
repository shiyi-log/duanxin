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

## 使用与法律合规

使用者必须遵守设备所在地、部署地及通信服务适用的法律法规。严禁将本项目源码、固件或衍生工具用于任何违法活动，包括未经授权访问或控制设备、网络及第三方系统，非法截取或披露通信内容和个人信息，发送诈骗、骚扰或垃圾信息，或干扰他人通信与公共服务。仅可在自有设备或已获得明确授权的设备和网络上进行测试；使用者须自行确认授权范围并对部署和使用行为负责。本项目不授予访问任何设备、网络或通信数据的权限。

本节是项目合规政策提醒，不是法律意见，也不保证在所有司法辖区自动构成可执行的合同条款。仓库目前未附单独的软件许可证；GitHub 服务条款允许用户在平台内查看和 fork 公开仓库，但仓库尚未明确授予平台外的常规复用、修改和再分发许可。详情见 [GitHub 许可证说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。按用途限制合法使用也可能与 [OSI 开源定义](https://opensource.org/osd) 不兼容；如需正式许可条款，应先确定许可证并进行法律审阅。
