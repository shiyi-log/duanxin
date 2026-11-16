#include "maintenance.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app_state.h"
#include "boot_guard.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define CONSOLE_LINE_SIZE 4096
#define LOG_RING_COUNT 48
#define LOG_LINE_SIZE 192

static const char *TAG = "maintenance";
static fw_config_t *s_config;
static vprintf_like_t s_original_vprintf;
static portMUX_TYPE s_log_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_log_ring[LOG_RING_COUNT][LOG_LINE_SIZE];
static unsigned s_log_next;
static unsigned s_log_count;

static int tee_log(const char *format, va_list args)
{
    char line[LOG_LINE_SIZE];
    va_list copy;
    va_copy(copy, args);
    vsnprintf(line, sizeof(line), format, copy);
    va_end(copy);

    portENTER_CRITICAL(&s_log_lock);
    snprintf(s_log_ring[s_log_next], LOG_LINE_SIZE, "%s", line);
    s_log_next = (s_log_next + 1) % LOG_RING_COUNT;
    if (s_log_count < LOG_RING_COUNT) ++s_log_count;
    portEXIT_CRITICAL(&s_log_lock);

    if (s_original_vprintf) return s_original_vprintf(format, args);
    return vprintf(format, args);
}

static cJSON *status_json(void)
{
    cJSON *status = cJSON_CreateObject();
    const esp_app_desc_t *app = esp_app_get_description();
    if (!status) return NULL;
    cJSON_AddStringToObject(status, "version", app ? app->version : "unknown");
    cJSON_AddBoolToObject(status, "config_valid", g_app_runtime.config_valid);
    cJSON_AddBoolToObject(status, "safe_mode", g_app_runtime.safe_mode);
    cJSON_AddBoolToObject(status, "wifi_connected", g_app_runtime.wifi_connected);
    cJSON_AddBoolToObject(status, "web_available", g_app_runtime.web_available);
    cJSON_AddBoolToObject(status, "modem_available", g_app_runtime.modem_available);
    cJSON_AddStringToObject(status, "mode", s_config ? s_config->mode : "unknown");
    cJSON_AddStringToObject(status, "reason", g_app_runtime.reason ? g_app_runtime.reason : "");
    return status;
}

static cJSON *logs_json(void)
{
    cJSON *array = cJSON_CreateArray();
    if (!array) return NULL;
    char snapshot[LOG_RING_COUNT][LOG_LINE_SIZE];
    unsigned count;
    portENTER_CRITICAL(&s_log_lock);
    count = s_log_count;
    unsigned start = (s_log_next + LOG_RING_COUNT - count) % LOG_RING_COUNT;
    for (unsigned i = 0; i < count; ++i) {
        memcpy(snapshot[i], s_log_ring[(start + i) % LOG_RING_COUNT], LOG_LINE_SIZE);
    }
    portEXIT_CRITICAL(&s_log_lock);
    for (unsigned i = 0; i < count; ++i) cJSON_AddItemToArray(array, cJSON_CreateString(snapshot[i]));
    return array;
}

static cJSON *make_response(const cJSON *request, bool ok, cJSON *data, const char *error)
{
    cJSON *response = cJSON_CreateObject();
    if (!response) {
        cJSON_Delete(data);
        return NULL;
    }
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(request, "id");
    cJSON_AddNumberToObject(response, "v", 1);
    if (id && (cJSON_IsString(id) || cJSON_IsNumber(id))) cJSON_AddItemToObject(response, "id", cJSON_Duplicate(id, true));
    cJSON_AddBoolToObject(response, "ok", ok);
    if (data) cJSON_AddItemToObject(response, "data", data);
    if (error) cJSON_AddStringToObject(response, "error", error);
    return response;
}

static cJSON *error_response(const cJSON *request, const char *message)
{
    return make_response(request, false, NULL, message);
}

cJSON *maintenance_handle_json(const cJSON *request)
{
    if (!cJSON_IsObject(request)) return error_response(request, "request must be a JSON object");
    const cJSON *op_item = cJSON_GetObjectItemCaseSensitive(request, "op");
    if (!cJSON_IsString(op_item) || !op_item->valuestring) return error_response(request, "missing op");
    const char *op = op_item->valuestring;

    if (strcmp(op, "status") == 0) return make_response(request, true, status_json(), NULL);
    if (strcmp(op, "logs") == 0) return make_response(request, true, logs_json(), NULL);
    if (strcmp(op, "config.get") == 0) return make_response(request, true, fw_config_to_json(s_config, false), NULL);
    if (strcmp(op, "config.export") == 0) return make_response(request, true, fw_config_to_json(s_config, true), NULL);

    if (strcmp(op, "config.set") == 0 || strcmp(op, "config.clear") == 0) {
        const cJSON *key = cJSON_GetObjectItemCaseSensitive(request, "key");
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(request, "value");
        if (!cJSON_IsString(key)) return error_response(request, "key must be a string");
        if (strcmp(op, "config.clear") == 0) value = NULL;
        if (value && !cJSON_IsString(value)) return error_response(request, "value must be a string");
        esp_err_t err = fw_config_set(s_config, key->valuestring, value ? value->valuestring : "");
        if (err != ESP_OK) return error_response(request, "unknown key or value is too long/invalid");
        cJSON *data = cJSON_CreateObject();
        cJSON_AddBoolToObject(data, "staged", true);
        return make_response(request, true, data, NULL);
    }

    if (strcmp(op, "config.save") == 0) {
        esp_err_t err = config_store_save(s_config);
        if (err != ESP_OK) return error_response(request, "configuration validation or NVS save failed");
        g_app_runtime.config_valid = true;
        g_app_runtime.safe_mode = false;
        g_app_runtime.reason = "configuration saved; reboot to apply network changes";
        boot_guard_clear();
        cJSON *data = cJSON_CreateObject();
        cJSON_AddNumberToObject(data, "generation", s_config->generation);
        cJSON_AddBoolToObject(data, "reboot_required", true);
        return make_response(request, true, data, NULL);
    }

    if (strcmp(op, "config.import") == 0) {
        const cJSON *input = cJSON_GetObjectItemCaseSensitive(request, "config");
        fw_config_t next = *s_config;
        esp_err_t err = fw_config_from_json(&next, input);
        if (err == ESP_OK) err = config_store_save(&next);
        if (err != ESP_OK) return error_response(request, "import rejected; check fields and required credentials");
        *s_config = next;
        g_app_runtime.config_valid = true;
        g_app_runtime.safe_mode = false;
        boot_guard_clear();
        cJSON *data = cJSON_CreateObject();
        cJSON_AddNumberToObject(data, "generation", s_config->generation);
        cJSON_AddBoolToObject(data, "reboot_required", true);
        return make_response(request, true, data, NULL);
    }

    if (strcmp(op, "config.reset") == 0) {
        const cJSON *confirm = cJSON_GetObjectItemCaseSensitive(request, "confirm");
        if (!cJSON_IsTrue(confirm)) return error_response(request, "set confirm=true to reset configuration");
        esp_err_t err = config_store_reset(s_config);
        if (err != ESP_OK) return error_response(request, "reset defaults are incomplete; provision credentials then save");
        g_app_runtime.config_valid = true;
        boot_guard_clear();
        cJSON *data = cJSON_CreateObject();
        cJSON_AddBoolToObject(data, "reboot_required", true);
        return make_response(request, true, data, NULL);
    }

    if (strcmp(op, "recovery.clear") == 0) {
        boot_guard_clear();
        cJSON *data = cJSON_CreateObject();
        cJSON_AddBoolToObject(data, "rebooting", true);
        cJSON *response = make_response(request, true, data, NULL);
        app_request_reboot();
        return response;
    }

    if (strcmp(op, "reboot") == 0) {
        cJSON *data = cJSON_CreateObject();
        cJSON_AddBoolToObject(data, "rebooting", true);
        cJSON *response = make_response(request, true, data, NULL);
        app_request_reboot();
        return response;
    }

    if (strcmp(op, "ota.status") == 0) {
        const esp_partition_t *running = esp_ota_get_running_partition();
        esp_ota_img_states_t state;
        esp_err_t state_err = esp_ota_get_state_partition(running, &state);
        cJSON *data = cJSON_CreateObject();
        cJSON_AddStringToObject(data, "partition", running ? running->label : "unknown");
        cJSON_AddStringToObject(data, "state", state_err == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY ? "pending_verify" : "valid_or_unavailable");
        return make_response(request, true, data, NULL);
    }

    if (strcmp(op, "ota.rollback") == 0) {
        cJSON *response = make_response(request, true, cJSON_CreateString("rebooting to previous valid image"), NULL);
        esp_ota_mark_app_invalid_rollback_and_reboot();
        return response;
    }

    return error_response(request, "unsupported operation");
}

static void print_response(const cJSON *request, cJSON *response)
{
    (void)request;
    char *text = cJSON_PrintUnformatted(response);
    if (text) {
        printf("@%s\r\n", text);
        free(text);
    }
    cJSON_Delete(response);
}

static void cli_help(void)
{
    printf("USB maintenance commands:\r\n"
           "  help                       Show this help\r\n"
           "  status                     Show runtime state\r\n"
           "  logs                       Show recent log ring\r\n"
           "  config show                Show config with secrets masked\r\n"
           "  config set KEY VALUE       Stage a value (use quotes only for JSON API)\r\n"
           "  config save                Validate and save staged config\r\n"
           "  config reset confirm       Restore defaults\r\n"
           "  ota status | ota rollback  Inspect or roll back firmware\r\n"
           "  recovery clear             Clear boot guard and reboot\r\n"
           "  reboot                     Restart device\r\n"
           "JSONL requests are also accepted; responses begin with @.\r\n");
}

static void cli_command(char *line)
{
    while (*line == ' ' || *line == '\t') ++line;
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\r' || line[len - 1] == '\n' || line[len - 1] == ' ')) line[--len] = '\0';
    if (!len) return;
    if (line[0] == '{') {
        cJSON *request = cJSON_Parse(line);
        if (!request) {
            printf("@{\"v\":1,\"ok\":false,\"error\":\"invalid JSON\"}\r\n");
            return;
        }
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "help") == 0) { cli_help(); return; }
    if (strcmp(line, "status") == 0) {
        cJSON *request = cJSON_Parse("{\"id\":\"cli\",\"op\":\"status\"}");
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "logs") == 0) {
        cJSON *request = cJSON_Parse("{\"id\":\"cli\",\"op\":\"logs\"}");
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "config show") == 0) {
        cJSON *request = cJSON_Parse("{\"id\":\"cli\",\"op\":\"config.get\"}");
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strncmp(line, "config set ", 11) == 0) {
        char *key = line + 11;
        char *value = strchr(key, ' ');
        if (!value) { printf("usage: config set KEY VALUE\r\n"); return; }
        *value++ = '\0';
        cJSON *request = cJSON_CreateObject();
        cJSON_AddStringToObject(request, "id", "cli");
        cJSON_AddStringToObject(request, "op", "config.set");
        cJSON_AddStringToObject(request, "key", key);
        cJSON_AddStringToObject(request, "value", value);
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "config save") == 0) {
        cJSON *request = cJSON_Parse("{\"id\":\"cli\",\"op\":\"config.save\"}");
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "config reset confirm") == 0) {
        cJSON *request = cJSON_Parse("{\"id\":\"cli\",\"op\":\"config.reset\",\"confirm\":true}");
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "ota status") == 0 || strcmp(line, "ota rollback") == 0) {
        const char *op = strcmp(line, "ota status") == 0 ? "ota.status" : "ota.rollback";
        cJSON *request = cJSON_CreateObject();
        cJSON_AddStringToObject(request, "op", op);
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    if (strcmp(line, "recovery clear") == 0 || strcmp(line, "reboot") == 0) {
        const char *op = strcmp(line, "reboot") == 0 ? "reboot" : "recovery.clear";
        cJSON *request = cJSON_CreateObject();
        cJSON_AddStringToObject(request, "op", op);
        print_response(request, maintenance_handle_json(request));
        cJSON_Delete(request);
        return;
    }
    printf("unknown command; type help\r\n");
}

static void maintenance_task(void *arg)
{
    (void)arg;
    char line[CONSOLE_LINE_SIZE];
    printf("\r\nWIFI Forwarder maintenance console ready. Type help.\r\n");
    while (true) {
        if (!fgets(line, sizeof(line), stdin)) {
            vTaskDelay(pdMS_TO_TICKS(25));
            continue;
        }
        cli_command(line);
    }
}

void maintenance_start(fw_config_t *config)
{
    s_config = config;
    s_original_vprintf = esp_log_set_vprintf(tee_log);
    xTaskCreate(maintenance_task, "usb_maintenance", 7168, NULL, 4, NULL);
}
