#include "fw_config.h"

#include <stddef.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "config_store";
static int s_active_slot = -1;

static uint32_t crc32_bytes(const void *data, size_t length)
{
    const uint8_t *bytes = data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < length; ++i) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)-(int32_t)(crc & 1u));
        }
    }
    return ~crc;
}

static uint32_t config_crc(const fw_config_t *config)
{
    return crc32_bytes(config, offsetof(fw_config_t, crc32));
}

static bool read_slot(int slot, fw_config_t *config)
{
    const char *name = slot == 0 ? "fw_cfg_a" : "fw_cfg_b";
    nvs_handle_t handle;
    if (nvs_open(name, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    size_t size = sizeof(*config);
    esp_err_t err = nvs_get_blob(handle, "payload", config, &size);
    nvs_close(handle);
    return err == ESP_OK && size == sizeof(*config) &&
        config->magic == FW_CONFIG_MAGIC && config->schema == FW_CONFIG_SCHEMA &&
        config->crc32 == config_crc(config);
}

esp_err_t config_store_load(fw_config_t *config)
{
    fw_config_t a = {0};
    fw_config_t b = {0};
    bool valid_a = read_slot(0, &a);
    bool valid_b = read_slot(1, &b);
    if (!valid_a && !valid_b) {
        s_active_slot = -1;
        fw_config_defaults(config);
        return ESP_ERR_NOT_FOUND;
    }
    if (valid_a && (!valid_b || (int32_t)(a.generation - b.generation) > 0)) {
        *config = a;
        s_active_slot = 0;
    } else {
        *config = b;
        s_active_slot = 1;
    }
    ESP_LOGI(TAG, "Loaded configuration generation %lu",
             (unsigned long)config->generation);
    return ESP_OK;
}

esp_err_t config_store_save(fw_config_t *config)
{
    char reason[96];
    if (!fw_config_validate(config, reason, sizeof(reason))) {
        ESP_LOGW(TAG, "Rejected invalid configuration: %s", reason);
        return ESP_ERR_INVALID_ARG;
    }

    fw_config_t next = *config;
    next.magic = FW_CONFIG_MAGIC;
    next.schema = FW_CONFIG_SCHEMA;
    next.generation = config->generation + 1;
    next.crc32 = config_crc(&next);
    int target = s_active_slot == 0 ? 1 : 0;
    const char *name = target == 0 ? "fw_cfg_a" : "fw_cfg_b";
    nvs_handle_t handle;
    esp_err_t err = nvs_open(name, NVS_READWRITE, &handle);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(handle, "payload", &next, sizeof(next));
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    if (err != ESP_OK) return err;

    fw_config_t verify = {0};
    if (!read_slot(target, &verify)) return ESP_ERR_INVALID_CRC;
    *config = verify;
    s_active_slot = target;
    ESP_LOGI(TAG, "Saved configuration generation %lu",
             (unsigned long)config->generation);
    return ESP_OK;
}

esp_err_t config_store_reset(fw_config_t *config)
{
    if (!config) return ESP_ERR_INVALID_ARG;

    fw_config_t defaults;
    fw_config_defaults(&defaults);
    defaults.generation = config->generation;

    esp_err_t err = config_store_save(&defaults);
    if (err == ESP_OK) *config = defaults;
    return err;
}
