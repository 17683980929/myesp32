idf_component_register(
    SRCS "lcd.c" "buttons.c" "sensors.c" "pcf85063.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_adc esp_lcd
    PRIV_REQUIRES esp_timer
)
