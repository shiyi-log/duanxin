import csv
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ProjectContractTests(unittest.TestCase):
    def test_partition_layout_matches_preserved_flash_map(self):
        rows = list(csv.reader((ROOT / "partitions.csv").read_text(encoding="ascii").splitlines()))
        partitions = {row[0].strip(): (int(row[3], 0), int(row[4], 0)) for row in rows if row and not row[0].lstrip().startswith("#")}
        self.assertEqual(partitions["nvs"], (0x9000, 0x5000))
        self.assertEqual(partitions["app0"], (0x10000, 0x140000))
        self.assertEqual(partitions["app1"], (0x150000, 0x140000))
        self.assertEqual(partitions["storage"], (0x290000, 0x160000))
        self.assertEqual(partitions["coredump"], (0x3F0000, 0x10000))
        self.assertEqual(max(offset + size for offset, size in partitions.values()), 0x400000)

    def test_recovery_features_are_enabled_and_modem_is_gated(self):
        defaults = (ROOT / "sdkconfig.defaults").read_text(encoding="ascii")
        self.assertIn("CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y", defaults)
        self.assertIn("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y", defaults)
        self.assertIn("CONFIG_FW_MODEM_UART_NUM=-1", defaults)
        modem = (ROOT / "main" / "modem_service.c").read_text(encoding="utf-8")
        self.assertIn("CONFIG_FW_MODEM_TX_GPIO >= 0", modem)
        self.assertIn("CONFIG_FW_MODEM_RX_GPIO >= 0", modem)

    def test_webserial_panel_and_device_routes_are_present(self):
        page = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
        server = (ROOT / "main" / "web_server.c").read_text(encoding="utf-8")
        self.assertIn("navigator.serial", script)
        self.assertIn("/api/maintenance", server)
        self.assertIn("/api/ota", server)
        self.assertIn("name=\"web_admin_password\"", page)
        self.assertIn("data-clear=\"ap_password\"", page)


if __name__ == "__main__":
    unittest.main()
