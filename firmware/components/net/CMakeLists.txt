idf_component_register(
    SRCS "wifi_sta.c" "ws_client.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_event esp_netif json esp_websocket_client
)
