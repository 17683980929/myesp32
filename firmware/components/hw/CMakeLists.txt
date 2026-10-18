idf_component_register(
    SRCS "lcd.c" "buttons.c" "sensors.c" "rtc.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_adc esp_lcd
)
