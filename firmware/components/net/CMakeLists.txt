idf_component_register(
    SRCS "wifi_sta.c" "wifi_cfg.c" "wifi_portal.c" "ws_client.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_event esp_netif esp_http_server lwip json esp_websocket_client nvs_flash
)
