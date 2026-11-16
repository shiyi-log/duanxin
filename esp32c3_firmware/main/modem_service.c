#include "modem_service.h"

#include "sdkconfig.h"
#include "driver/uart.h"
#include "esp_log.h"

static const char *TAG = "ml307a";
static bool s_available;

esp_err_t modem_service_start(void)
{
#if CONFIG_FW_MODEM_UART_NUM >= 0 && CONFIG_FW_MODEM_TX_GPIO >= 0 && CONFIG_FW_MODEM_RX_GPIO >= 0
    const uart_port_t port = (uart_port_t)CONFIG_FW_MODEM_UART_NUM;
    const uart_config_t uart_config = {
        .baud_rate = CONFIG_FW_MODEM_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    esp_err_t err = uart_param_config(port, &uart_config);
    if (err != ESP_OK) return err;
    err = uart_set_pin(port, CONFIG_FW_MODEM_TX_GPIO, CONFIG_FW_MODEM_RX_GPIO,
                       UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err != ESP_OK) return err;
    err = uart_driver_install(port, 2048, 2048, 0, NULL, 0);
    if (err != ESP_OK) return err;
    s_available = true;
    ESP_LOGW(TAG, "UART transport enabled; modem protocol remains gated pending board verification");
    return ESP_OK;
#else
    s_available = false;
    ESP_LOGW(TAG, "Modem disabled until UART pins and baud are verified for this board");
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

bool modem_service_available(void)
{
    return s_available;
}
