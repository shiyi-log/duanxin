#include "app_state.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "boot_guard.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "modem_service.h"
#include "maintenance.h"
#include "sdkconfig.h"
#include "web_server.h"
#include "nvs_flash.h"

fw_config_t g_fw_config;
app_runtime_t g_app_runtime;
static const char *TAG = "app";
static bool s_reboot_queued;
static esp_netif_t *s_wifi_ap_netif;
static esp_netif_t *s_wifi_sta_netif;
static bool s_wifi_initialized;
static bool s_wifi_started;
static bool s_wifi_handler_registered;
static bool s_ip_handler_registered;
static bool s_wifi_ever_connected;

#define AP_START_DELAY_MS 10000
#define INITIAL_AP_SSID "SMS-Forwarder-AP"

static void reboot_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(900));
    esp_restart();
}

void app_request_reboot(void)
{
    if (!s_reboot_queued) {
        s_reboot_queued = true;
        xTaskCreate(reboot_task, "delayed_reboot", 2048, NULL, 5, NULL);
    }
}

static void copy_wifi_field(void *destination, size_t destination_size,
                            const char *source, size_t source_size)
{
    char *output = destination;
    size_t length = 0;
    while (length < source_size && source[length] != '\0') length++;
    if (length > destination_size) length = destination_size;
    memcpy(output, source, length);
    if (length < destination_size) memset(output + length, 0, destination_size - length);
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        g_app_runtime.wifi_connected = false;
        if (strcmp(g_fw_config.mode, "wifi") == 0) {
            if (s_wifi_ever_connected) {
                uint8_t mac[6] = {0};
                char ssid[33] = "ESP32-AP-000000";
                if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
                    snprintf(ssid, sizeof(ssid), "ESP32-AP-%02X%02X%02X",
                             mac[3], mac[4], mac[5]);
                }
                esp_wifi_set_mode(WIFI_MODE_APSTA);
                wifi_config_t ap = {0};
                copy_wifi_field(ap.ap.ssid, sizeof(ap.ap.ssid), ssid, strlen(ssid));
                ap.ap.ssid_len = strlen((char *)ap.ap.ssid);
                copy_wifi_field(ap.ap.password, sizeof(ap.ap.password),
                                g_fw_config.ap_password, sizeof(g_fw_config.ap_password));
                ap.ap.channel = 1;
                ap.ap.max_connection = 4;
                ap.ap.authmode = strlen(g_fw_config.ap_password) >= 8 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
                if (esp_wifi_set_config(WIFI_IF_AP, &ap) == ESP_OK) {
                    g_app_runtime.ap_active = true;
                    snprintf(g_app_runtime.ap_ssid, sizeof(g_app_runtime.ap_ssid), "%s", ssid);
                    ESP_LOGW(TAG, "Wi-Fi unavailable; recovery AP active: %s", ssid);
                }
            }
            esp_wifi_connect();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        g_app_runtime.wifi_connected = true;
        s_wifi_ever_connected = true;
        esp_err_t mode_err = esp_wifi_set_mode(WIFI_MODE_STA);
        if (mode_err == ESP_OK) {
            g_app_runtime.ap_active = false;
            g_app_runtime.ap_ssid[0] = '\0';
        } else {
            ESP_LOGW(TAG, "Could not disable setup AP after Wi-Fi connected: %s",
                     esp_err_to_name(mode_err));
        }
        ESP_LOGI(TAG, "Wi-Fi uplink connected");
    }
}

static esp_err_t set_setup_ap(const char *ssid)
{
    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (err != ESP_OK) return err;
    wifi_config_t ap = {0};
    snprintf((char *)ap.ap.ssid, sizeof(ap.ap.ssid), "%s", ssid);
    ap.ap.ssid_len = strlen((char *)ap.ap.ssid);
    copy_wifi_field(ap.ap.password, sizeof(ap.ap.password),
                    g_fw_config.ap_password, sizeof(g_fw_config.ap_password));
    ap.ap.channel = 1;
    ap.ap.max_connection = 4;
    ap.ap.authmode = strlen(g_fw_config.ap_password) >= 8 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    err = esp_wifi_set_config(WIFI_IF_AP, &ap);
    if (err != ESP_OK) return err;
    g_app_runtime.ap_active = true;
    snprintf(g_app_runtime.ap_ssid, sizeof(g_app_runtime.ap_ssid), "%s", ssid);
    if (ap.ap.authmode == WIFI_AUTH_OPEN) {
        ESP_LOGW(TAG, "Setup AP has no WPA2 password; set one before field deployment");
    }
    ESP_LOGI(TAG, "Setup AP active: %s", ssid);
    return ESP_OK;
}

static void fallback_ap_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(AP_START_DELAY_MS));
    if (!g_app_runtime.wifi_connected && !g_app_runtime.ap_active) {
        esp_err_t err = set_setup_ap(INITIAL_AP_SSID);
        if (err != ESP_OK) ESP_LOGE(TAG, "Could not start setup AP: %s", esp_err_to_name(err));
    }
    vTaskDelete(NULL);
}

static esp_err_t schedule_fallback_ap(void)
{
    BaseType_t created = xTaskCreate(fallback_ap_task, "setup_ap_fallback", 3072,
                                     NULL, 4, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

static esp_err_t ensure_wifi_stack(bool include_ap)
{
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    if (include_ap && !s_wifi_ap_netif) {
        s_wifi_ap_netif = esp_netif_create_default_wifi_ap();
        if (!s_wifi_ap_netif) return ESP_FAIL;
    }
    if (!s_wifi_sta_netif) {
        s_wifi_sta_netif = esp_netif_create_default_wifi_sta();
        if (!s_wifi_sta_netif) return ESP_FAIL;
    }

    if (!s_wifi_initialized) {
        wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
        err = esp_wifi_init(&init);
        if (err != ESP_OK) return err;
        s_wifi_initialized = true;
    }
    if (!s_wifi_handler_registered) {
        err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL);
        if (err != ESP_OK) return err;
        s_wifi_handler_registered = true;
    }
    if (!s_ip_handler_registered) {
        err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL);
        if (err != ESP_OK) return err;
        s_ip_handler_registered = true;
    }
    return ESP_OK;
}

esp_err_t app_wifi_scan(cJSON **records)
{
    if (!records) return ESP_ERR_INVALID_ARG;
    *records = NULL;

    esp_err_t err = ensure_wifi_stack(false);
    if (err != ESP_OK) return err;
    if (!s_wifi_started) {
        err = esp_wifi_set_mode(WIFI_MODE_STA);
        if (err != ESP_OK) return err;
        err = esp_wifi_start();
        if (err != ESP_OK) return err;
        s_wifi_started = true;
    } else {
        wifi_mode_t mode;
        err = esp_wifi_get_mode(&mode);
        if (err != ESP_OK) return err;
        if (mode == WIFI_MODE_AP) {
            err = esp_wifi_set_mode(WIFI_MODE_APSTA);
            if (err != ESP_OK) return err;
        }
    }

    wifi_scan_config_t scan = {0};
    err = esp_wifi_scan_start(&scan, true);
    if (err != ESP_OK) return err;

    uint16_t count = 0;
    err = esp_wifi_scan_get_ap_num(&count);
    if (err != ESP_OK) return err;
    if (count > 40) count = 40;

    wifi_ap_record_t *aps = count ? calloc(count, sizeof(*aps)) : NULL;
    if (count && !aps) return ESP_ERR_NO_MEM;
    if (count) {
        err = esp_wifi_scan_get_ap_records(&count, aps);
        if (err != ESP_OK) {
            free(aps);
            return err;
        }
    }

    cJSON *array = cJSON_CreateArray();
    if (!array) {
        free(aps);
        return ESP_ERR_NO_MEM;
    }
    for (uint16_t i = 0; i < count; ++i) {
        cJSON *item = cJSON_CreateObject();
        char ssid[sizeof(aps[i].ssid) + 1] = {0};
        memcpy(ssid, aps[i].ssid, sizeof(aps[i].ssid));
        if (!item || !cJSON_AddStringToObject(item, "ssid", ssid) ||
            !cJSON_AddNumberToObject(item, "rssi", aps[i].rssi) ||
            !cJSON_AddNumberToObject(item, "channel", aps[i].primary) ||
            !cJSON_AddNumberToObject(item, "authmode", aps[i].authmode) ||
            !cJSON_AddItemToArray(array, item)) {
            cJSON_Delete(item);
            cJSON_Delete(array);
            free(aps);
            return ESP_ERR_NO_MEM;
        }
    }
    free(aps);
    *records = array;
    return ESP_OK;
}

static esp_err_t start_wifi_and_web(void)
{
    esp_err_t err = ensure_wifi_stack(true);
    if (err != ESP_OK) return err;

    bool station_configured = strcmp(g_fw_config.mode, "wifi") == 0 && g_fw_config.wifi_ssid[0];
    if (station_configured) {
        wifi_config_t station = {0};
        copy_wifi_field(station.sta.ssid, sizeof(station.sta.ssid),
                        g_fw_config.wifi_ssid, sizeof(g_fw_config.wifi_ssid));
        copy_wifi_field(station.sta.password, sizeof(station.sta.password),
                        g_fw_config.wifi_password, sizeof(g_fw_config.wifi_password));
        station.sta.threshold.authmode = WIFI_AUTH_OPEN;
        err = esp_wifi_set_config(WIFI_IF_STA, &station);
        if (err != ESP_OK) return err;
    }
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) return err;
    if (!s_wifi_started) {
        err = esp_wifi_start();
        if (err != ESP_OK) return err;
        s_wifi_started = true;
    }
    if (strcmp(g_fw_config.mode, "wifi") == 0 && g_fw_config.wifi_ssid[0]) {
        err = esp_wifi_connect();
        if (err != ESP_OK) ESP_LOGW(TAG, "Initial Wi-Fi connect request failed: %s", esp_err_to_name(err));
    }

    esp_err_t web_err = web_server_start();
    if (web_err == ESP_OK) g_app_runtime.web_available = true;
    err = schedule_fallback_ap();
    if (err != ESP_OK) ESP_LOGE(TAG, "Could not create setup AP fallback task");
    return web_err;
}

static esp_err_t start_recovery_network(void)
{
    esp_err_t err = ensure_wifi_stack(true);
    if (err != ESP_OK) return err;
    bool station_configured = g_app_runtime.config_valid &&
        strcmp(g_fw_config.mode, "wifi") == 0 && g_fw_config.wifi_ssid[0];
    if (station_configured) {
        wifi_config_t station = {0};
        copy_wifi_field(station.sta.ssid, sizeof(station.sta.ssid),
                        g_fw_config.wifi_ssid, sizeof(g_fw_config.wifi_ssid));
        copy_wifi_field(station.sta.password, sizeof(station.sta.password),
                        g_fw_config.wifi_password, sizeof(g_fw_config.wifi_password));
        station.sta.threshold.authmode = WIFI_AUTH_OPEN;
        err = esp_wifi_set_config(WIFI_IF_STA, &station);
        if (err != ESP_OK) return err;
    }
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) return err;
    if (!s_wifi_started) {
        err = esp_wifi_start();
        if (err != ESP_OK) return err;
        s_wifi_started = true;
    }
    if (station_configured) {
        err = esp_wifi_connect();
        if (err != ESP_OK) ESP_LOGW(TAG, "Recovery Wi-Fi connect request failed: %s", esp_err_to_name(err));
    }
    err = web_server_start();
    if (err == ESP_OK) g_app_runtime.web_available = true;
    esp_err_t ap_err = schedule_fallback_ap();
    if (ap_err != ESP_OK) ESP_LOGE(TAG, "Could not create recovery AP fallback task");
    return err;
}

void app_main(void)
{
    memset(&g_app_runtime, 0, sizeof(g_app_runtime));
    fw_config_defaults(&g_fw_config);
    bool boot_recovery = boot_guard_begin();

    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_OK) {
        esp_err_t load_err = config_store_load(&g_fw_config);
        g_app_runtime.config_valid = load_err == ESP_OK;
        if (!g_app_runtime.config_valid) {
            g_app_runtime.reason = load_err == ESP_ERR_NOT_FOUND
                ? "first startup; initialize over USB or the setup AP"
                : "configuration missing/invalid; initialize over USB or the setup AP";
        }
    } else {
        g_app_runtime.reason = "NVS unavailable; automatic erase is disabled; USB maintenance is active";
        ESP_LOGE(TAG, "NVS init failed (%s); preserving flash contents", esp_err_to_name(nvs_err));
    }

    g_app_runtime.safe_mode = boot_recovery || !g_app_runtime.config_valid;
    if (boot_recovery) g_app_runtime.reason = "repeated startup failure; safe mode active";
    esp_err_t maintenance_err = maintenance_start(&g_fw_config);
    bool maintenance_ready = maintenance_err == ESP_OK;
    if (!maintenance_ready) {
        g_app_runtime.reason = "USB maintenance task failed to start";
        ESP_LOGE(TAG, "USB maintenance could not start: %s", esp_err_to_name(maintenance_err));
    }

    bool network_services_ready = false;
    bool modem_required = strcmp(g_fw_config.mode, "cellular") == 0;
    if (g_app_runtime.config_valid && !g_app_runtime.safe_mode) {
        esp_err_t modem_err = ESP_ERR_NOT_SUPPORTED;
        if (modem_required) {
            modem_err = modem_service_start();
            g_app_runtime.modem_available = modem_err == ESP_OK && modem_service_available();
        } else {
            g_app_runtime.modem_available = false;
            ESP_LOGI(TAG, "Cellular uplink disabled; modem UART is not started");
        }
        if (modem_required && !g_app_runtime.modem_available) {
            g_app_runtime.reason = "cellular service unavailable; USB maintenance remains active";
            ESP_LOGE(TAG, "Selected cellular mode but modem transport did not start: %s",
                     esp_err_to_name(modem_err));
        }
        esp_err_t net_err = start_wifi_and_web();
        if (net_err != ESP_OK) {
            g_app_runtime.reason = "AP/web startup failed; USB maintenance remains active";
            ESP_LOGE(TAG, "Network service start failed: %s", esp_err_to_name(net_err));
        } else {
            network_services_ready = !modem_required || g_app_runtime.modem_available;
        }
    } else {
        ESP_LOGW(TAG, "Starting USB maintenance and delayed Wi-Fi recovery AP");
        esp_err_t recovery_err = start_recovery_network();
        if (recovery_err != ESP_OK) {
            ESP_LOGE(TAG, "Wi-Fi recovery AP unavailable: %s", esp_err_to_name(recovery_err));
        }
    }

    bool services_ready = maintenance_ready && g_app_runtime.config_valid &&
        !g_app_runtime.safe_mode && network_services_ready;
    bool ota_confirmation_ready = true;
    if (services_ready) {
        const esp_partition_t *running = esp_ota_get_running_partition();
        if (!running) {
            ota_confirmation_ready = false;
            ESP_LOGE(TAG, "Cannot identify running app partition; startup remains unconfirmed");
        } else {
            esp_ota_img_states_t ota_state;
            esp_err_t state_err = esp_ota_get_state_partition(running, &ota_state);
            if (state_err == ESP_OK && ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
                esp_err_t mark_err = esp_ota_mark_app_valid_cancel_rollback();
                if (mark_err != ESP_OK) {
                    ota_confirmation_ready = false;
                    ESP_LOGE(TAG, "OTA health confirmation failed: %s", esp_err_to_name(mark_err));
                }
            } else if (state_err != ESP_OK && state_err != ESP_ERR_NOT_FOUND) {
                ota_confirmation_ready = false;
                ESP_LOGE(TAG, "OTA state check failed: %s", esp_err_to_name(state_err));
            }
        }
    }

    if (services_ready && ota_confirmation_ready) {
        boot_guard_mark_healthy();
        ESP_LOGI(TAG, "Startup health checks passed; USB maintenance remains available");
    } else {
        ESP_LOGW(TAG, "Startup remains unconfirmed; boot-failure guard is retained (usb=%u config=%u safe=%u net=%u)",
                 maintenance_ready, g_app_runtime.config_valid, g_app_runtime.safe_mode,
                 network_services_ready);
    }
}
