"""Optional read-only HTTP smoke tests for a device on its recovery AP."""

import hashlib
import json
import os
from pathlib import Path
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("ESP32_TEST_BASE_URL", "").rstrip("/")
SECRET_KEYS = (
    "wifi_password",
    "wifi2_password",
    "ap_password",
    "web_admin_password",
    "smtp_password",
    "pushplus_token",
    "gotify_token",
    "telegram_bot_token",
    "server_token",
)


def http_request(path, *, payload=None, content_type="application/json"):
    data = None if payload is None else payload.encode("utf-8")
    headers = {} if content_type is None else {"Content-Type": content_type}
    request = Request(f"{BASE_URL}{path}", data=data, headers=headers)
    try:
        with urlopen(request, timeout=12) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def maintenance_request(op):
    payload = json.dumps({"v": 1, "id": f"live-{op}", "op": op})
    status, body = http_request("/api/maintenance", payload=payload)
    return status, json.loads(body) if status == 200 and body else {}


@unittest.skipUnless(BASE_URL, "set ESP32_TEST_BASE_URL to the device recovery AP")
class LiveDeviceHttpTests(unittest.TestCase):
    def test_web_assets_match_workspace(self):
        for route, relative_path in (
            ("/", "web/index.html"),
            ("/app.js", "web/app.js"),
            ("/style.css", "web/style.css"),
        ):
            with self.subTest(route=route):
                status, body = http_request(route)
                self.assertEqual(status, 200)
                expected = (ROOT / relative_path).read_bytes()
                self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256(expected).digest())

    def test_recovery_ap_status_config_redaction_and_wifi_scan(self):
        status_code, status = maintenance_request("status")
        self.assertEqual(status_code, 200)
        self.assertTrue(status.get("ok"))
        self.assertEqual(status.get("id"), "live-status")
        self.assertTrue(status["data"]["safe_mode"])
        self.assertTrue(status["data"]["ap_active"])

        config_code, config = maintenance_request("config.get")
        self.assertEqual(config_code, 200)
        self.assertTrue(config.get("ok"))
        self.assertEqual(config.get("id"), "live-config.get")
        for key in SECRET_KEYS:
            with self.subTest(secret=key):
                self.assertIsNone(config["data"][key])
                self.assertIsInstance(config["data"][f"{key}_configured"], bool)

        scan_code, scan = maintenance_request("wifi.scan")
        self.assertEqual(scan_code, 200)
        self.assertTrue(scan.get("ok"))
        self.assertIsInstance(scan.get("data"), list)
        for network in scan["data"]:
            with self.subTest(network=network.get("ssid")):
                self.assertIsInstance(network.get("ssid"), str)
                self.assertIsInstance(network.get("rssi"), int)
                self.assertIsInstance(network.get("channel"), int)
                self.assertGreaterEqual(network["channel"], 1)
                self.assertLessEqual(network["channel"], 14)
                self.assertIsInstance(network.get("authmode"), int)

        config_after_scan_code, config_after_scan = maintenance_request("config.get")
        self.assertEqual(config_after_scan_code, 200)
        self.assertEqual(config_after_scan["data"]["generation"], config["data"]["generation"])

        page_code, _ = http_request("/")
        self.assertEqual(page_code, 200)

    def test_unauthenticated_admin_and_ota_routes_are_denied(self):
        for op in ("logs", "ota.status", "config.export"):
            with self.subTest(op=op):
                code, _ = maintenance_request(op)
                self.assertEqual(code, 401)

        code, _ = http_request(
            "/api/ota",
            payload="",
            content_type="application/octet-stream",
        )
        self.assertEqual(code, 401)

    def test_invalid_recovery_config_updates_are_rejected_without_changes(self):
        status_code, status = maintenance_request("status")
        self.assertEqual(status_code, 200)
        self.assertTrue(status["data"]["safe_mode"])
        self.assertTrue(status["data"]["ap_active"])

        before_code, before = maintenance_request("config.get")
        self.assertEqual(before_code, 200)
        original_ssid = before["data"]["wifi_ssid"]
        original_generation = before["data"]["generation"]

        for request in (
            {"v": 1, "id": "live-config-long-ssid", "op": "config.set", "key": "wifi_ssid", "value": "x" * 33},
            {"v": 1, "id": "live-config-wrong-type", "op": "config.set", "key": "wifi_ssid", "value": 7},
        ):
            with self.subTest(request_id=request["id"]):
                code, body = http_request("/api/maintenance", payload=json.dumps(request))
                self.assertEqual(code, 200)
                response = json.loads(body)
                self.assertFalse(response["ok"])

        after_code, after = maintenance_request("config.get")
        self.assertEqual(after_code, 200)
        self.assertEqual(after["data"]["wifi_ssid"], original_ssid)
        self.assertEqual(after["data"]["generation"], original_generation)

    def test_invalid_json_is_rejected(self):
        code, _ = http_request("/api/maintenance", payload="{bad-json")
        self.assertEqual(code, 400)

    def test_empty_and_oversized_request_bodies_are_rejected(self):
        empty_code, _ = http_request("/api/maintenance", payload="")
        self.assertEqual(empty_code, 400)

        oversized_code, _ = http_request("/api/maintenance", payload=" " * 8193)
        self.assertEqual(oversized_code, 400)


if __name__ == "__main__":
    unittest.main()
