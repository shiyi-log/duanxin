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
    def test_first_boot_does_not_mark_default_template_as_initialized(self):
        source = (ROOT / "main" / "app_main.c").read_text(encoding="utf-8")
        body = c_function_body(source, "void app_main(void)")

        self.assertIn("first startup; initialize over USB or the setup AP", body)
        self.assertNotIn("config_store_save", body)
        self.assertIn("start_recovery_network()", body)

    def test_setup_ap_fallback_names_and_lifecycle_are_preserved(self):
        source = (ROOT / "main" / "app_main.c").read_text(encoding="utf-8")
        event = c_function_body(source, "static void wifi_event_handler(")
        fallback = c_function_body(source, "static void fallback_ap_task(")

        self.assertIn('#define AP_START_DELAY_MS 10000', source)
        self.assertIn('#define INITIAL_AP_SSID "SMS-Forwarder-AP"', source)
        self.assertIn('"ESP32-AP-%02X%02X%02X"', event)
        self.assertIn("esp_wifi_set_mode(WIFI_MODE_STA)", event)
        self.assertIn("ap_active = false", event)
        self.assertIn("set_setup_ap(INITIAL_AP_SSID)", fallback)
        self.assertNotIn("ESP32-AP", fallback)

    def test_unconfigured_web_recovery_is_limited_to_device_ap_clients(self):
        source = (ROOT / "main" / "web_server.c").read_text(encoding="utf-8")
        handler = c_function_body(source, "static esp_err_t maintenance_handler(")
        allowed = c_function_body(source, "static bool recovery_setup_operation(")
        peer_check = c_function_body(source, "static bool recovery_client_on_device_ap(")

        self.assertIn("g_app_runtime.safe_mode", handler)
        self.assertIn("g_app_runtime.ap_active", handler)
        self.assertIn("recovery_client_on_device_ap(request)", handler)
        self.assertIn("struct sockaddr_storage peer", peer_check)
        self.assertIn("peer.ss_family == AF_INET", peer_check)
        self.assertIn("peer.ss_family == AF_INET6", peer_check)
        self.assertIn("IN6_IS_ADDR_V4MAPPED", peer_check)
        self.assertIn("sin6_addr.s6_addr[12]", peer_check)
        self.assertIn("0xFFFFFF00u) == 0xC0A80400u", peer_check)
        self.assertIn('"config.save"', allowed)
        self.assertNotIn('"reboot"', allowed)
        self.assertNotIn('"config.reset"', allowed)

    def test_log_snapshot_uses_heap_not_maintenance_task_stack(self):
        source = (ROOT / "main" / "maintenance.c").read_text(encoding="utf-8")
        body = c_function_body(source, "static cJSON *logs_json(void)")

        self.assertIn("malloc(sizeof(s_log_ring))", body)
        self.assertNotIn("char snapshot[LOG_RING_COUNT][LOG_LINE_SIZE]", body)
        self.assertIn("free(snapshot)", body)

    def test_config_load_uses_heap_scratch_instead_of_large_stack_copies(self):
        source = (ROOT / "main" / "config_store.c").read_text(encoding="utf-8")
        body = c_function_body(source, "esp_err_t config_store_load(fw_config_t *config)")

        self.assertIn("fw_config_t *candidate = malloc(sizeof(*candidate));", body)
        self.assertNotIn("fw_config_t a", body)
        self.assertNotIn("fw_config_t b", body)
        self.assertIn("return ESP_ERR_NO_MEM", body)
        self.assertIn("free(candidate)", body)

    def test_ota_confirmation_waits_for_required_services(self):
        source = (ROOT / "main" / "app_main.c").read_text(encoding="utf-8")
        body = c_function_body(source, "void app_main(void)")
        gate = c_block_after(body, "if (services_ready)")

        self.assertIn("esp_err_t maintenance_err = maintenance_start(&g_fw_config);", body)
        self.assertIn("bool maintenance_ready = maintenance_err == ESP_OK;", body)
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
