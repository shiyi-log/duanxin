#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "cJSON.h"

#define FW_CONFIG_SCHEMA 1
#define FW_CONFIG_MAGIC 0x57464331u

typedef struct {
    uint32_t magic;
    uint32_t schema;
    uint32_t generation;
    char mode[12];
    char wifi_ssid[33];
    char wifi_password[65];
    char wifi2_ssid[33];
    char wifi2_password[65];
    char ap_password[65];
    char web_admin_password[65];
    char admin_phone[24];
    char own_phone[24];
    char note[96];
    uint32_t heartbeat_sec;
    uint32_t keepalive_sec;
    char smtp_host[128];
    char smtp_port[8];
    char smtp_user[96];
    char smtp_password[96];
    char smtp_to[128];
    char pushplus_token[128];
    char gotify_url[192];
    char gotify_token[128];
    char telegram_bot_token[128];
    char telegram_chat_id[64];
    char server_url[192];
    char server_token[128];
    uint32_t crc32;
} fw_config_t;

void fw_config_defaults(fw_config_t *config);
bool fw_config_validate(const fw_config_t *config, char *reason, size_t reason_size);
esp_err_t fw_config_set(fw_config_t *config, const char *key, const char *value);
cJSON *fw_config_to_json(const fw_config_t *config, bool include_secrets);
esp_err_t fw_config_from_json(fw_config_t *config, const cJSON *root);

esp_err_t config_store_load(fw_config_t *config);
esp_err_t config_store_save(fw_config_t *config);
esp_err_t config_store_reset(fw_config_t *config);
