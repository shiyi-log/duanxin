#pragma once

#include <stdbool.h>

#include "esp_err.h"

esp_err_t modem_service_start(void);
bool modem_service_available(void);
