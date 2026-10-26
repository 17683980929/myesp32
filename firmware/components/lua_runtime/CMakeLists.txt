idf_component_register(
    SRCS "lua_runtime.c"
    INCLUDE_DIRS "include"
    REQUIRES hw ui fatfs wear_levelling esp_timer heap audio net ble driver
)
