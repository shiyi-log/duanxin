#pragma once

#include <stdbool.h>

#include "fw_config.h"

typedef struct {
    bool config_valid;
    bool safe_mode;
    bool wifi_connected;
    bool web_available;
    bool modem_available;
    const char *reason;
} app_runtime_t;

extern fw_config_t g_fw_config;
extern app_runtime_t g_app_runtime;

void app_request_reboot(void);
