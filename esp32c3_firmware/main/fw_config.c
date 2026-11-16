#include "fw_config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sdkconfig.h"

static void set_reason(char *reason, size_t size, const char *message)
{
    if (reason && size) snprintf(reason, size, "%s", message);
}

void fw_config_defaults(fw_config_t *config)
{
    memset(config, 0, sizeof(*config));
    config->magic = FW_CONFIG_MAGIC;
    config->schema = FW_CONFIG_SCHEMA;
    snprintf(config->mode, sizeof(config->mode), "wifi");
    snprintf(config->ap_password, sizeof(config->ap_password), "%s", CONFIG_FW_AP_PASSWORD);
    snprintf(config->web_admin_password, sizeof(config->web_admin_password), "%s",
             CONFIG_FW_WEB_ADMIN_PASSWORD);
    config->heartbeat_sec = 3600;
    config->keepalive_sec = 86400;
    snprintf(config->smtp_port, sizeof(config->smtp_port), "465");
}

bool fw_config_validate(const fw_config_t *config, char *reason, size_t reason_size)
{
    if (strcmp(config->mode, "wifi") != 0 && strcmp(config->mode, "cellular") != 0) {
        set_reason(reason, reason_size, "mode must be wifi or cellular");
        return false;
    }
    size_t ap_password_len = strnlen(config->ap_password, sizeof(config->ap_password));
    size_t wifi_ssid_len = strnlen(config->wifi_ssid, sizeof(config->wifi_ssid));
    size_t wifi_password_len = strnlen(config->wifi_password, sizeof(config->wifi_password));
    if (ap_password_len < 8 || ap_password_len > 63 ||
        ap_password_len == sizeof(config->ap_password)) {
        set_reason(reason, reason_size, "set an AP password from 8 to 63 characters");
        return false;
    }
    if (wifi_ssid_len == sizeof(config->wifi_ssid) || wifi_ssid_len > 32 ||
        wifi_password_len == sizeof(config->wifi_password) || wifi_password_len > 63) {
        set_reason(reason, reason_size, "Wi-Fi SSID/password exceeds supported length");
        return false;
    }
    if (strlen(config->web_admin_password) < 12) {
        set_reason(reason, reason_size, "set a web administrator password with at least 12 characters");
        return false;
    }
    if (config->heartbeat_sec < 60 || config->heartbeat_sec > 604800 ||
        config->keepalive_sec < 300 || config->keepalive_sec > 2592000) {
        set_reason(reason, reason_size, "heartbeat/keepalive interval is outside supported bounds");
        return false;
    }
    set_reason(reason, reason_size, "");
    return true;
}

typedef struct {
    const char *key;
    char *value;
    size_t capacity;
    bool secret;
} string_field_t;

static size_t string_fields(fw_config_t *config, string_field_t *fields)
{
    const string_field_t source[] = {
        {"mode", config->mode, sizeof(config->mode), false},
        {"wifi_ssid", config->wifi_ssid, sizeof(config->wifi_ssid), false},
        {"wifi_password", config->wifi_password, sizeof(config->wifi_password), true},
        {"wifi2_ssid", config->wifi2_ssid, sizeof(config->wifi2_ssid), false},
        {"wifi2_password", config->wifi2_password, sizeof(config->wifi2_password), true},
        {"ap_password", config->ap_password, sizeof(config->ap_password), true},
        {"web_admin_password", config->web_admin_password, sizeof(config->web_admin_password), true},
        {"admin_phone", config->admin_phone, sizeof(config->admin_phone), false},
        {"own_phone", config->own_phone, sizeof(config->own_phone), false},
        {"note", config->note, sizeof(config->note), false},
        {"smtp_host", config->smtp_host, sizeof(config->smtp_host), false},
        {"smtp_port", config->smtp_port, sizeof(config->smtp_port), false},
        {"smtp_user", config->smtp_user, sizeof(config->smtp_user), false},
        {"smtp_password", config->smtp_password, sizeof(config->smtp_password), true},
        {"smtp_to", config->smtp_to, sizeof(config->smtp_to), false},
        {"pushplus_token", config->pushplus_token, sizeof(config->pushplus_token), true},
        {"gotify_url", config->gotify_url, sizeof(config->gotify_url), false},
        {"gotify_token", config->gotify_token, sizeof(config->gotify_token), true},
        {"telegram_bot_token", config->telegram_bot_token, sizeof(config->telegram_bot_token), true},
        {"telegram_chat_id", config->telegram_chat_id, sizeof(config->telegram_chat_id), false},
        {"server_url", config->server_url, sizeof(config->server_url), false},
        {"server_token", config->server_token, sizeof(config->server_token), true},
    };
    memcpy(fields, source, sizeof(source));
    return sizeof(source) / sizeof(source[0]);
}

esp_err_t fw_config_set(fw_config_t *config, const char *key, const char *value)
{
    if (!key || !value) return ESP_ERR_INVALID_ARG;
    if (strcmp(key, "heartbeat_sec") == 0 || strcmp(key, "keepalive_sec") == 0) {
        char *end = NULL;
        unsigned long number = strtoul(value, &end, 10);
        if (!value[0] || !end || *end || number > UINT32_MAX) return ESP_ERR_INVALID_ARG;
        if (key[0] == 'h') config->heartbeat_sec = (uint32_t)number;
        else config->keepalive_sec = (uint32_t)number;
        return ESP_OK;
    }
    string_field_t fields[24];
    size_t count = string_fields(config, fields);
    for (size_t i = 0; i < count; ++i) {
        if (strcmp(key, fields[i].key) != 0) continue;
        size_t length = strlen(value);
        if (length >= fields[i].capacity) return ESP_ERR_INVALID_SIZE;
        memcpy(fields[i].value, value, length + 1);
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

cJSON *fw_config_to_json(const fw_config_t *config, bool include_secrets)
{
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;
    fw_config_t copy = *config;
    string_field_t fields[24];
    size_t count = string_fields(&copy, fields);
    for (size_t i = 0; i < count; ++i) {
        if (fields[i].secret && !include_secrets) {
            cJSON_AddNullToObject(root, fields[i].key);
            char flag[48];
            snprintf(flag, sizeof(flag), "%s_configured", fields[i].key);
            cJSON_AddBoolToObject(root, flag, fields[i].value[0] != '\0');
        } else {
            cJSON_AddStringToObject(root, fields[i].key, fields[i].value);
        }
    }
    cJSON_AddNumberToObject(root, "heartbeat_sec", config->heartbeat_sec);
    cJSON_AddNumberToObject(root, "keepalive_sec", config->keepalive_sec);
    cJSON_AddNumberToObject(root, "generation", config->generation);
    return root;
}

esp_err_t fw_config_from_json(fw_config_t *config, const cJSON *root)
{
    if (!cJSON_IsObject(root)) return ESP_ERR_INVALID_ARG;
    fw_config_t next = *config;
    string_field_t fields[24];
    size_t count = string_fields(&next, fields);
    for (size_t i = 0; i < count; ++i) {
        const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, fields[i].key);
        if (!item || cJSON_IsNull(item)) continue;
        if (!cJSON_IsString(item) || fw_config_set(&next, fields[i].key, item->valuestring) != ESP_OK) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    const cJSON *heartbeat = cJSON_GetObjectItemCaseSensitive(root, "heartbeat_sec");
    const cJSON *keepalive = cJSON_GetObjectItemCaseSensitive(root, "keepalive_sec");
    if (heartbeat) {
        if (!cJSON_IsNumber(heartbeat) || heartbeat->valuedouble < 0) return ESP_ERR_INVALID_ARG;
        next.heartbeat_sec = (uint32_t)heartbeat->valuedouble;
    }
    if (keepalive) {
        if (!cJSON_IsNumber(keepalive) || keepalive->valuedouble < 0) return ESP_ERR_INVALID_ARG;
        next.keepalive_sec = (uint32_t)keepalive->valuedouble;
    }
    char reason[96];
    if (!fw_config_validate(&next, reason, sizeof(reason))) return ESP_ERR_INVALID_ARG;
    *config = next;
    return ESP_OK;
}
