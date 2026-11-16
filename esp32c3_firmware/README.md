# ESP32-C3 WiFi Forwarder Firmware

This is a new ESP-IDF project. The original flash image and reference documents in the parent folder are left untouched.

## Current implementation

- USB Serial/JTAG maintenance console, available before Wi-Fi initialization.
- Versioned configuration stored in alternating NVS slots with CRC validation. Startup never erases NVS automatically.
- Three-failure boot guard and USB safe mode.
- AP+STA networking with the configuration AP kept up while the station link is used.
- SPIFFS-hosted configuration page, local WebSerial panel, configuration import/export, and authenticated OTA upload.
- Dual application slots and bootloader rollback support.
- ML307A UART transport remains disabled by default. The board's UART pins, control pins, and baud rate have not been verified; modem messaging and notification behavior must not be enabled until they are.

The original firmware configuration is not migrated. Enter Wi-Fi, phone, and service credentials again after the new firmware is ready.

## Install and build

The project targets ESP-IDF `v5.5.1`, matching the release recorded in the original image metadata. On this workstation, ESP-IDF and its toolchain are installed under `C:\Espressif` through ESP-IDF Installation Manager. Load its generated PowerShell profile before building (adjust the path if ESP-IDF is installed elsewhere):

```powershell
. 'C:\Espressif\tools\Microsoft.v5.5.1.PowerShell_profile.ps1'
```

Before building, run the generated ESP-IDF PowerShell export script, then configure the two distinct local secrets under **WiFi Forwarder** in `idf.py menuconfig`:

- Configuration AP password: at least 8 characters.
- Web administrator password: at least 12 characters.

Do not place real credentials in this repository or in shared logs. If these secrets are unset, firmware stays in USB maintenance mode until provisioned.

From the repository root in an ESP-IDF PowerShell:

```powershell
cd .\esp32c3_firmware
idf.py set-target esp32c3
idf.py menuconfig
idf.py build
```

Review the generated partition and binary sizes before flashing. Do not flash the board until the application size, AP behavior, USB recovery, and OTA rollback have been validated. The saved full-flash image remains the recovery baseline.

## USB maintenance

For a direct terminal connection, open the device's USB Serial/JTAG COM port at 115200 and use:

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

The console also accepts one JSON request per line. Requests use `{"v":1,"id":"1","op":"status"}`; replies start with `@` and contain the same `id`. Supported operations include `status`, `logs`, `config.get`, `config.set`, `config.clear`, `config.save`, `config.import`, `config.export`, `config.reset`, `ota.status`, `ota.rollback`, `recovery.clear`, and `reboot`.

Start the host browser panel from the project folder using the workspace's esptool Python environment:

```powershell
..\.venv-esptool\Scripts\python.exe .\tools\usb_panel\serve.py
```

Then open `http://127.0.0.1:8765/` in desktop Chrome or Edge, connect USB, and edit the same configuration. The page is served locally and does not need an internet connection.

## Recovery boundary

The application console handles configuration, network, and failed-update recovery. If both app slots or the ROM USB path are unusable, ESP32-C3 ROM download mode may still require the physical boot strap during reset. No firmware-only design can guarantee recovery from a damaged boot path. Keep any original full-flash image private as a recovery baseline.
