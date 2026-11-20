#pragma once

#include <stdbool.h>

#include "fw_config.h"

typedef struct {
    bool config_valid;
    bool safe_mode;
    bool wifi_connected;
    bool ap_active;
    bool web_available;
    bool modem_available;
    char ap_ssid[33];
    const char *reason;
} app_runtime_t;

extern fw_config_t g_fw_config;
extern app_runtime_t g_app_runtime;

void app_request_reboot(void);
esp_err_t app_wifi_scan(cJSON **records);
