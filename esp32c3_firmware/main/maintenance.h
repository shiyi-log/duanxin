#pragma once

#include "cJSON.h"
#include "esp_err.h"
#include "fw_config.h"

esp_err_t maintenance_start(fw_config_t *config);
cJSON *maintenance_handle_json(const cJSON *request);
