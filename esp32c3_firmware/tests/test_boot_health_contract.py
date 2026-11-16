from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def c_function_body(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1:index]
    raise AssertionError(f"unclosed function body: {signature}")


def c_block_after(source, marker):
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening + 1:index]
    raise AssertionError(f"unclosed block after: {marker}")


class BootHealthContractTests(unittest.TestCase):
    def test_ota_confirmation_waits_for_required_services(self):
        source = (ROOT / "main" / "app_main.c").read_text(encoding="utf-8")
        body = c_function_body(source, "void app_main(void)")
        gate = c_block_after(body, "if (services_ready)")

        self.assertIn('xTaskGetHandle("usb_maintenance")', body)
        self.assertIn("maintenance_ready && g_app_runtime.config_valid", body)
        self.assertIn("!g_app_runtime.safe_mode && network_services_ready", body)
        self.assertIn('strcmp(g_fw_config.mode, "cellular") == 0', body)
        self.assertIn("esp_ota_mark_app_valid_cancel_rollback()", gate)

    def test_boot_guard_clears_only_after_successful_health_confirmation(self):
        app_source = (ROOT / "main" / "app_main.c").read_text(encoding="utf-8")
        body = c_function_body(app_source, "void app_main(void)")
        healthy_block = c_block_after(body, "if (services_ready && ota_confirmation_ready)")
        self.assertIn("boot_guard_mark_healthy()", healthy_block)
        self.assertEqual(body.count("boot_guard_mark_healthy()"), 1)

    def test_unhealthy_restart_keeps_failure_count_across_reset_reasons(self):
        source = (ROOT / "main" / "boot_guard.c").read_text(encoding="utf-8")
        body = c_function_body(source, "bool boot_guard_begin(void)")

        self.assertNotIn("esp_reset_reason", body)
        self.assertIn("if (s_boot_state.magic != BOOT_GUARD_MAGIC)", body)
        self.assertIn("if (s_boot_state.pending_start && s_boot_state.failed_starts < UINT32_MAX)", body)
        self.assertIn("++s_boot_state.failed_starts", body)
        self.assertIn("return s_boot_state.failed_starts >= BOOT_FAILURE_LIMIT", body)


if __name__ == "__main__":
    unittest.main()
