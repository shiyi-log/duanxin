#pragma once

#include "cJSON.h"
#include "fw_config.h"

void maintenance_start(fw_config_t *config);
cJSON *maintenance_handle_json(const cJSON *request);
