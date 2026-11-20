#include "web_server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app_state.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_spiffs.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "mbedtls/constant_time.h"
#include "maintenance.h"

#define WEB_ROOT_FILE "/spiffs/index.html"
#define API_BODY_LIMIT 8192

static const char *TAG = "web";
static httpd_handle_t s_server;

static bool authorized(httpd_req_t *request)
{
    char supplied[96] = {0};
    const char *expected = g_fw_config.web_admin_password;
    if (!expected[0] || strlen(expected) >= sizeof(supplied)) return false;
    if (httpd_req_get_hdr_value_len(request, "X-Admin-Password") >= sizeof(supplied)) return false;
    if (httpd_req_get_hdr_value_str(request, "X-Admin-Password", supplied, sizeof(supplied)) != ESP_OK) return false;
    size_t supplied_len = strlen(supplied);
    size_t expected_len = strlen(expected);
    return supplied_len == expected_len && mbedtls_ct_memcmp(supplied, expected, expected_len) == 0;
}

static bool recovery_setup_operation(const cJSON *op)
{
    if (!cJSON_IsString(op) || !op->valuestring) return false;
    return strcmp(op->valuestring, "config.get") == 0 ||
           strcmp(op->valuestring, "config.set") == 0 ||
           strcmp(op->valuestring, "config.clear") == 0 ||
           strcmp(op->valuestring, "config.save") == 0 ||
           strcmp(op->valuestring, "wifi.scan") == 0;
}

static bool recovery_client_on_device_ap(httpd_req_t *request)
{
    struct sockaddr_storage peer = {0};
    socklen_t peer_size = sizeof(peer);
    int fd = httpd_req_to_sockfd(request);
    int peer_result = getpeername(fd, (struct sockaddr *)&peer, &peer_size);
    if (peer_result != 0) {
        ESP_LOGW(TAG, "Recovery AP peer lookup failed: rc=%d", peer_result);
        return false;
    }

    uint32_t peer_addr;
    if (peer.ss_family == AF_INET) {
        const struct sockaddr_in *peer4 = (const struct sockaddr_in *)&peer;
        peer_addr = peer4->sin_addr.s_addr;
    } else if (peer.ss_family == AF_INET6) {
        const struct sockaddr_in6 *peer6 = (const struct sockaddr_in6 *)&peer;
        if (!IN6_IS_ADDR_V4MAPPED(&peer6->sin6_addr)) return false;
        memcpy(&peer_addr, &peer6->sin6_addr.s6_addr[12], sizeof(peer_addr));
    } else {
        return false;
    }

    uint32_t peer_host = ntohl(peer_addr);
    bool on_device_ap = (peer_host & 0xFFFFFF00u) == 0xC0A80400u;
    ESP_LOGD(TAG, "Recovery AP peer=%08lx allowed=%d",
             (unsigned long)peer_host, on_device_ap);
    return on_device_ap;
}

static esp_err_t send_json(httpd_req_t *request, cJSON *json)
{
    if (!json) return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    char *body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!body) return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "serialization failed");
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    esp_err_t err = httpd_resp_send(request, body, HTTPD_RESP_USE_STRLEN);
    free(body);
    return err;
}

static char *read_request_body(httpd_req_t *request, size_t limit)
{
    if (request->content_len == 0 || request->content_len > limit) return NULL;
    char *body = calloc(1, request->content_len + 1);
    if (!body) return NULL;
    size_t received = 0;
    while (received < request->content_len) {
        int count = httpd_req_recv(request, body + received, request->content_len - received);
        if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (count <= 0) {
            free(body);
            return NULL;
        }
        received += (size_t)count;
    }
    return body;
}

static esp_err_t index_handler(httpd_req_t *request)
{
    FILE *file = fopen(WEB_ROOT_FILE, "rb");
    if (!file) return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "configuration page unavailable");
    httpd_resp_set_type(request, "text/html; charset=utf-8");
    char buffer[1024];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        if (httpd_resp_send_chunk(request, buffer, count) != ESP_OK) {
            fclose(file);
            httpd_resp_sendstr_chunk(request, NULL);
            return ESP_FAIL;
        }
    }
    fclose(file);
    return httpd_resp_send_chunk(request, NULL, 0);
}

static esp_err_t asset_handler(httpd_req_t *request)
{
    const char *path = NULL;
    const char *content_type = NULL;
    if (strcmp(request->uri, "/style.css") == 0) {
        path = "/spiffs/style.css";
        content_type = "text/css; charset=utf-8";
    } else if (strcmp(request->uri, "/app.js") == 0) {
        path = "/spiffs/app.js";
        content_type = "application/javascript; charset=utf-8";
    } else {
        return httpd_resp_send_err(request, HTTPD_404_NOT_FOUND, "asset not found");
    }

    FILE *file = fopen(path, "rb");
    if (!file) return httpd_resp_send_err(request, HTTPD_404_NOT_FOUND, "asset unavailable");
    httpd_resp_set_type(request, content_type);
    char buffer[1024];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        if (httpd_resp_send_chunk(request, buffer, count) != ESP_OK) {
            fclose(file);
            httpd_resp_sendstr_chunk(request, NULL);
            return ESP_FAIL;
        }
    }
    fclose(file);
    return httpd_resp_send_chunk(request, NULL, 0);
}

static esp_err_t maintenance_handler(httpd_req_t *request)
{
    char *body = read_request_body(request, API_BODY_LIMIT);
    if (!body) return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid request body");
    cJSON *input = cJSON_Parse(body);
    free(body);
    if (!input) return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "invalid JSON");
    const cJSON *op = cJSON_GetObjectItemCaseSensitive(input, "op");
    bool is_status = cJSON_IsString(op) && strcmp(op->valuestring, "status") == 0;
    bool recovery_setup = g_app_runtime.safe_mode && g_app_runtime.ap_active &&
                          recovery_setup_operation(op) && recovery_client_on_device_ap(request);
    if (!is_status && !authorized(request) && !recovery_setup) {
        cJSON_Delete(input);
        return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "administrator password required");
    }
    cJSON *response = maintenance_handle_json(input);
    cJSON_Delete(input);
    return send_json(request, response);
}

static esp_err_t ota_handler(httpd_req_t *request)
{
    if (!authorized(request)) return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, "administrator password required");
    if (request->content_len < 4096 || request->content_len > 0x140000) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "firmware image size is invalid");
    }
    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
    if (!update_partition || request->content_len > update_partition->size) {
        return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "firmware image does not fit update slot");
    }
    esp_ota_handle_t handle;
    esp_err_t err = esp_ota_begin(update_partition, request->content_len, &handle);
    if (err != ESP_OK) return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "cannot begin OTA write");

    uint8_t buffer[1024];
    size_t remaining = request->content_len;
    while (remaining) {
        size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
        int count = httpd_req_recv(request, (char *)buffer, chunk);
        if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (count <= 0) {
            esp_ota_abort(handle);
            return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "firmware transfer interrupted");
        }
        err = esp_ota_write(handle, buffer, (size_t)count);
        if (err != ESP_OK) {
            esp_ota_abort(handle);
            return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "firmware write failed");
        }
        remaining -= (size_t)count;
    }
    err = esp_ota_end(handle);
    if (err != ESP_OK) return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "firmware image validation failed");
    err = esp_ota_set_boot_partition(update_partition);
    if (err != ESP_OK) return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, "cannot select update image");

    httpd_resp_set_type(request, "application/json");
    httpd_resp_sendstr(request, "{\"ok\":true,\"rebooting\":true}");
    ESP_LOGI(TAG, "OTA image verified; restarting into update slot");
    vTaskDelay(pdMS_TO_TICKS(700));
    esp_restart();
    return ESP_OK;
}

esp_err_t web_server_start(void)
{
    esp_vfs_spiffs_conf_t fs_conf = {
        .base_path = "/spiffs",
        .partition_label = "storage",
        .max_files = 5,
        .format_if_mount_failed = false,
    };
    esp_err_t err = esp_vfs_spiffs_register(&fs_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SPIFFS mount failed; USB maintenance remains available (%s)", esp_err_to_name(err));
        return err;
    }

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 8;
    config.stack_size = 7168;
    err = httpd_start(&s_server, &config);
    if (err != ESP_OK) return err;

    httpd_uri_t index = {.uri = "/", .method = HTTP_GET, .handler = index_handler};
    httpd_uri_t style = {.uri = "/style.css", .method = HTTP_GET, .handler = asset_handler};
    httpd_uri_t script = {.uri = "/app.js", .method = HTTP_GET, .handler = asset_handler};
    httpd_uri_t api = {.uri = "/api/maintenance", .method = HTTP_POST, .handler = maintenance_handler};
    httpd_uri_t ota = {.uri = "/api/ota", .method = HTTP_POST, .handler = ota_handler};
    if ((err = httpd_register_uri_handler(s_server, &index)) != ESP_OK ||
        (err = httpd_register_uri_handler(s_server, &style)) != ESP_OK ||
        (err = httpd_register_uri_handler(s_server, &script)) != ESP_OK ||
        (err = httpd_register_uri_handler(s_server, &api)) != ESP_OK ||
        (err = httpd_register_uri_handler(s_server, &ota)) != ESP_OK) {
        httpd_stop(s_server);
        s_server = NULL;
        return err;
    }
    ESP_LOGI(TAG, "Configuration page ready at http://192.168.4.1/");
    return ESP_OK;
}
